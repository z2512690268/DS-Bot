// Work a Bot starts on its own: the team's proactive mode decides whether it is done,
// only recorded for the user to see, or not started at all.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { PROACTIVE_MODE, PROACTIVE_MODES, proactiveOf, stalledReport, workStateOf } from '../src/host/work-state.js'

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  works: {},
  requests: {},
  prefs: {},
  revision: 0,
})

async function startHost(home, config = {}) {
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined },
        id: sessionId,
        calls: [],
        status: 'idle',
        followup(message) { this.calls.push(['followup', message]) },
        steer(message) { this.calls.push(['steer', message]) },
        inject() {},
        cancel() {},
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: { nextStep: [], nextTurn: [], remove: () => false },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => undefined,
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home, ...config })
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  await tool('list_bots', {}, 'a')
  return { rt, agents, tool, stop: async () => { await ctx.dispose() } }
}

function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-proactive-'))
  const hosts = []
  t.after(async () => {
    for (const host of hosts.reverse()) await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { start: async (config) => { const host = await startHost(home, config); hosts.push(host); return host } }
}

// A turn that the user did not start and no group message named: the Bot decides.
function ownInitiative(rt, sessionId) {
  rt.live.set(sessionId, { turn: 1, info: { kind: 'relay', role: 'room', exchangeId: 'r1' } })
}

test('the proactive mode is observe unless the config says otherwise', () => {
  assert.equal(PROACTIVE_MODE, 'observe')
  assert.deepEqual(PROACTIVE_MODES, ['off', 'observe', 'auto'])
  assert.equal(proactiveOf(), 'observe')
  assert.equal(proactiveOf({ proactive: 'auto' }), 'auto')
  assert.equal(proactiveOf({ proactive: 'off' }), 'off')
  assert.equal(proactiveOf({ proactive: 'sometimes' }), 'observe')
})

test('a proposal is a state only the user can end, and has no lease to run out', () => {
  const work = { at: 1, proposal: { at: 5, text: 'rewrite the changelog' }, lease: { at: 1 } }
  const state = workStateOf(work, 10)
  assert.equal(state.state, 'person/proposed')
  assert.equal(state.since, 5)
  assert.equal(state.proposed, true)
  assert.equal(state.summary, 'rewrite the changelog')
  assert.equal(stalledReport(work, Date.now() + 60 * 60_000), undefined)
})

test('what started the turn decides the authority of the request it sends', async (t) => {
  const { rt } = await bench(t).start()
  const chat = rt.chatOf('a')
  const exec = { agent: { id: chat } }
  rt.live.set(chat, { turn: 1 })
  assert.equal(rt.workAuthorityOf(exec), 'asked')
  rt.live.set(chat, { turn: 1, info: { kind: 'relay', role: 'request', exchangeId: 'w1' } })
  assert.equal(rt.workAuthorityOf(exec), 'delegated')
  rt.live.set(chat, { turn: 1, info: { kind: 'relay', role: 'room', exchangeId: 'r1' } })
  assert.equal(rt.workAuthorityOf(exec), 'proposed')
  rt.live.set(chat, { turn: 1, info: { kind: 'relay', role: 'room', exchangeId: 'r1', askedBy: 'b' } })
  assert.equal(rt.workAuthorityOf(exec), 'asked')
  // A member the user named in the group's message was asked, not left to its own.
  rt.live.set(chat, { turn: 1, info: { kind: 'relay', role: 'room', exchangeId: 'r1', namedByUser: true } })
  assert.equal(rt.workAuthorityOf(exec), 'asked')
  // The group's admin leads a round the user started; the members it leads do not.
  rt.live.set(chat, { turn: 1, info: { kind: 'relay', role: 'room', exchangeId: 'r1' } })
  rt.groupOwners.set(chat, { botId: 'a', roomId: 'r1' })
  rt.state.rooms.r1 = { id: 'r1', name: 'Ops', members: ['a', 'b'], admin: 'a', seq: 0 }
  assert.equal(rt.workAuthorityOf(exec), 'asked')
  rt.state.rooms.r1.admin = 'b'
  assert.equal(rt.workAuthorityOf(exec), 'proposed')
  rt.groupOwners.delete(chat)
  // A Bot answering another Bot's work keeps that work's authority.
  rt.openWork('w2', { from: 'b', to: 'a' })
  rt.live.set(chat, { turn: 1, info: { kind: 'relay', role: 'request', exchangeId: 'w2' } })
  assert.equal(rt.workAuthorityOf(exec), 'delegated')
  rt.state.works.w2.authority = 'proposed'
  assert.equal(rt.workAuthorityOf(exec), 'proposed')
})

test('observe records what the Bot would have done and sends nothing', async (t) => {
  const { rt, agents, tool } = await bench(t).start()
  const chat = rt.chatOf('a')
  ownInitiative(rt, chat)
  const out = await tool('message_bot', { to: 'Writer', message: 'update the changelog' }, chat)
  assert.match(out, /observe mode/)
  assert.match(out, /recorded as a proposal/)
  assert.equal(agents.get(rt.chatOf('b'))?.calls.length ?? 0, 0, 'nothing reached the other Bot')
  const works = Object.values(rt.state.works)
  assert.equal(works.length, 1)
  assert.equal(works[0].authority, 'proposed')
  assert.equal(works[0].proposal.text, 'update the changelog')
  assert.deepEqual(works[0].open, [])
  const item = rt.needsYou().find(entry => entry.kind === 'proposed')
  assert.ok(item, 'the proposal waits under Needs you')
  assert.equal(item.to, 'Writer')
  assert.equal(item.summary, 'update the changelog')
  // Repeating the same request must not record a second proposal.
  assert.match(await tool('message_bot', { to: 'Writer', message: 'update the changelog' }, chat), /recorded as a proposal/)
  assert.equal(Object.values(rt.state.works).length, 1)
  // It has no lease, so a sweep cannot call it stalled.
  assert.equal(rt.sweepStalled(Date.now() + 24 * 60 * 60_000), false)
})

test('auto sends the work a Bot started on its own, and off refuses it', async (t) => {
  const auto = await bench(t).start({ proactive: 'auto' })
  const chat = auto.rt.chatOf('a')
  ownInitiative(auto.rt, chat)
  const sent = await auto.tool('message_bot', { to: 'Writer', message: 'update the changelog' }, chat)
  assert.match(sent, /Delivered to Writer/)
  assert.equal(auto.agents.get(auto.rt.chatOf('b')).calls.length, 1)
  const opened = Object.values(auto.rt.state.works)
  assert.equal(opened.length, 1)
  assert.equal(opened[0].authority, 'proposed')
  assert.equal(auto.rt.needsYou().filter(entry => entry.kind === 'proposed').length, 0)

  const off = await bench(t).start({ proactive: 'off' })
  const offChat = off.rt.chatOf('a')
  ownInitiative(off.rt, offChat)
  const refused = await off.tool('message_bot', { to: 'Writer', message: 'update the changelog' }, offChat)
  assert.match(refused, /proactive work is off/)
  assert.equal(Object.values(off.rt.state.works).length, 0, 'nothing is recorded either')
  assert.equal(off.agents.get(off.rt.chatOf('b'))?.calls.length ?? 0, 0)
})
