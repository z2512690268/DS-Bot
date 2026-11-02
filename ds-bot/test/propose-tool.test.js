// The propose tool: a Bot that sees work in a group round nobody called it into records
// it instead of doing it, the user approves it once, and then the Bot is asked to do it.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { SOURCE_KIND } from '../src/host/constants.js'

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], admin: 'b', seq: 0 } },
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
  const prompts = []
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
      prompt: async (request) => { prompts.push(request) },
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home, ...config })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  await tool('list_bots', {}, 'a')
  return { rt, ctx, emit, tool, prompts, stop: async () => { await ctx.dispose() } }
}

function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-propose-'))
  const hosts = []
  t.after(async () => {
    for (const host of hosts.reverse()) await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { start: async (config) => { const host = await startHost(home, config); hosts.push(host); return host } }
}

const textBlock = text => [{ type: 'text', text }]
const groupSource = (extra = {}) => ({ kind: SOURCE_KIND, form: 'relay', role: 'room', exchangeId: 'r1', roomId: 'r1', senderName: 'You', ...extra })

// A group round this Bot speaks in: the user wrote to the group and nobody named it.
function enterRound(host, extra = {}) {
  const chat = host.rt.chatOf('a')
  const turn = (host.rt.live.get(chat)?.turn ?? 0) + 1
  host.emit(chat, 'turn/start', { turn })
  host.emit(chat, 'user/message', { content: textBlock('（群里的消息）'), source: groupSource(extra) })
  return chat
}

function endRound(host) {
  const chat = host.rt.chatOf('a')
  const turn = host.rt.live.get(chat)?.turn ?? 1
  host.emit(chat, 'turn/end', { turn, reason: { kind: 'completed' } })
}

const proposals = rt => Object.entries(rt.state.works).filter(([, work]) => work.proposal !== undefined)

test('a private chat has no proposals to make', async (t) => {
  const { rt, tool } = await bench(t).start()
  rt.live.set(rt.chatOf('a'), { turn: 1 })
  const said = await tool('propose', { title: 'Check the changelog' }, 'a')
  assert.match(said, /only for a group round/)
  assert.equal(proposals(rt).length, 0)
})

test('a group round that did not call the Bot records what it would do, once', async (t) => {
  const host = await bench(t).start()
  const { rt, tool } = host
  const chat = enterRound(host)
  const said = await tool('propose', { title: 'Rewrite the changelog', reason: 'it is out of date' }, chat)
  assert.match(said, /Recorded as a proposal/)
  const [id, work] = proposals(rt)[0]
  assert.equal(work.authority, 'proposed')
  assert.equal(work.from, 'a')
  assert.equal(work.to, 'a', 'the Bot that offered it would do it')
  assert.equal(work.proposal.text, 'Rewrite the changelog')
  assert.equal(work.proposal.reason, 'it is out of date')
  assert.deepEqual(work.history.map(event => event.event), ['proposed'])
  const item = rt.needsYou().find(entry => entry.kind === 'proposed')
  assert.equal(item.work, id)
  assert.equal(item.summary, 'Rewrite the changelog')
  assert.equal(item.to, undefined, 'a proposal the Bot would do itself names no other Bot')
  // One per turn, and the next turn starts the count again.
  assert.match(await tool('propose', { title: 'Another idea' }, chat), /One proposal per turn/)
  assert.equal(proposals(rt).length, 1)
  endRound(host)
  const next = enterRound(host)
  assert.match(await tool('propose', { title: 'Another idea' }, next), /Recorded as a proposal/)
  assert.equal(proposals(rt).length, 2)
})

test('a round that called the Bot, or one it leads, is not a place to propose', async (t) => {
  const host = await bench(t).start()
  const { rt, tool } = host
  let chat = enterRound(host, { namedByUser: true })
  assert.match(await tool('propose', { title: 'Rewrite the changelog' }, chat), /This round called you/)
  endRound(host)
  chat = enterRound(host, { askedBy: 'b' })
  assert.match(await tool('propose', { title: 'Rewrite the changelog' }, chat), /This round called you/)
  endRound(host)
  rt.state.rooms.r1.admin = 'a'
  chat = enterRound(host)
  assert.match(await tool('propose', { title: 'Rewrite the changelog' }, chat), /lead this round/)
  assert.equal(proposals(rt).length, 0)
})

test('with proactive off a Bot does not propose at all', async (t) => {
  const host = await bench(t).start({ proactive: 'off' })
  const { rt, tool } = host
  const chat = enterRound(host)
  assert.match(await tool('propose', { title: 'Rewrite the changelog' }, chat), /Proactive work is off/)
  assert.equal(proposals(rt).length, 0)
})

test('approving a proposal asks the Bot to do it, once', async (t) => {
  const host = await bench(t).start()
  const { rt, tool, prompts } = host
  const chat = enterRound(host)
  await tool('propose', { title: 'Rewrite the changelog', reason: 'it is out of date' }, chat)
  const [id] = proposals(rt)[0]
  assert.deepEqual(await rt.approveProposal(id), { ok: true })
  assert.equal(prompts.length, 1, 'the Bot is asked once, in its chat')
  assert.equal(prompts[0].sessionId, chat)
  const said = prompts[0].content.map(block => block.text ?? '').join('')
  assert.match(said, /^\[The user approved this request\]/)
  assert.match(said, /Rewrite the changelog/)
  assert.match(said, /Why: it is out of date/)
  assert.equal(rt.state.works[id], undefined, 'the proposal is settled, not left open')
  assert.equal(rt.state.workLog.at(-1).final, 'approved')
  assert.equal(rt.needsYou().filter(item => item.kind === 'proposed').length, 0)
  // Approving again asks nothing.
  assert.match((await rt.approveProposal(id)).error, /not waiting any more/)
  assert.equal(prompts.length, 1)
  // A saved state that still holds the proposal sends nothing a second time.
  rt.state.works[id] = { from: 'a', to: 'a', authority: 'proposed', at: 1, lease: { at: 1, by: 'a' }, proposal: { at: 1, text: 'Rewrite the changelog', summary: 'Rewrite the changelog' }, open: [], results: [], history: [] }
  assert.deepEqual(await rt.approveProposal(id), { ok: true })
  assert.equal(prompts.length, 1)
  assert.equal(rt.state.works[id], undefined)
})
