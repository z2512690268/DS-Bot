// The user approves something a Bot would have done: it becomes the request the Bot
// meant to send, once, and it leaves the "I would have done" list.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { MESSAGE_INLINE_MAX } from '../src/host/constants.js'

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

async function startHost(home) {
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
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  await tool('list_bots', {}, 'a')
  return { rt, agents, tool, call, stop: async () => { await ctx.dispose() } }
}

function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-approve-'))
  const hosts = []
  t.after(async () => {
    for (const host of hosts.reverse()) await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { start: async () => { const host = await startHost(home); hosts.push(host); return host } }
}

const textOf = message => message.content.map(block => block.text ?? '').join('')

// A Bot that starts work in a group round nobody named it in: observe records it.
async function observedProposal(host, text = 'update the changelog') {
  const chat = host.rt.chatOf('a')
  host.rt.live.set(chat, { turn: 1, info: { kind: 'relay', role: 'room', exchangeId: 'r1' } })
  const said = await host.tool('message_bot', { to: 'Writer', message: text }, chat)
  assert.match(said, /observe mode/)
  const id = Object.keys(host.rt.state.works).find(work => host.rt.state.works[work].proposal !== undefined)
  assert.ok(id, 'a proposal was recorded')
  return id
}

test('approving a proposal sends the request the Bot meant to send, once', async (t) => {
  const host = await bench(t).start()
  const id = await observedProposal(host)
  assert.equal(host.rt.needsYou().find(item => item.kind === 'proposed').summary, 'update the changelog')
  assert.deepEqual(await host.rt.approveProposal(id), { ok: true })
  const calls = host.agents.get(host.rt.chatOf('b')).calls
  assert.equal(calls.length, 1, 'the request reached Writer')
  const message = calls[0][1]
  assert.equal(message.source.role, 'request')
  assert.equal(message.source.exchangeId, id, 'the answer comes back to the same work')
  assert.match(textOf(message), /^\[Message from Chief\]\n\[The user approved this request\]/)
  assert.match(textOf(message), /update the changelog/)
  // The record is the request now, and it has left the inbox.
  assert.equal(host.rt.state.works[id].proposal, undefined)
  assert.equal(host.rt.state.works[id].authority, 'asked')
  assert.deepEqual(host.rt.workHistory(id).map(event => event.event), ['proposed', 'approved'])
  assert.equal(host.rt.needsYou().filter(item => item.kind === 'proposed').length, 0)
  // Approving it again changes nothing and sends nothing.
  assert.match((await host.rt.approveProposal(id)).error, /not waiting any more/)
  assert.equal(host.agents.get(host.rt.chatOf('b')).calls.length, 1)
})

test('a state saved before the request went out does not send it twice', async (t) => {
  const host = await bench(t).start()
  const id = await observedProposal(host)
  await host.rt.approveProposal(id)
  // What a crash between the delivery and the save leaves behind: the receipt of the
  // first send, and the proposal still on the work.
  const work = host.rt.state.works[id]
  work.proposal = { at: Date.now() - 1_000, text: 'update the changelog', summary: 'update the changelog' }
  assert.deepEqual(await host.rt.approveProposal(id), { ok: true })
  assert.equal(host.agents.get(host.rt.chatOf('b')).calls.length, 1, 'the receipt stops the second send')
  assert.equal(host.rt.state.works[id].proposal, undefined, 'and the row leaves the list')
  assert.equal(host.rt.state.works[id].authority, 'asked')
})

test('a proposal saved in part is refused rather than sent as something else', async (t) => {
  const { rt } = await bench(t).start()
  const id = rt.proposeWork({ from: 'a', to: 'b', text: 'x'.repeat(MESSAGE_INLINE_MAX + 10) })
  assert.ok(id)
  const refused = await rt.approveProposal(id)
  assert.match(refused.error, /characters long/)
  assert.equal(rt.state.works[id].proposal !== undefined, true)
  assert.equal(rt.needsYou().filter(item => item.kind === 'proposed').length, 1)
})

test('only a waiting proposal can be approved', async (t) => {
  const { rt } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  assert.match((await rt.approveProposal('w1')).error, /not waiting any more/)
  const missing = await rt.approveProposal('nope')
  assert.match(missing.error, /not waiting any more/)
  assert.equal(missing.code, 'bot/stale')
})

test('the panel approves through the api', async (t) => {
  const host = await bench(t).start()
  const id = await observedProposal(host)
  const answer = await host.call('approve-proposal', { work: id })
  assert.equal(answer.ok, true)
  assert.equal(host.agents.get(host.rt.chatOf('b')).calls.length, 1)
  const nothing = await host.call('approve-proposal', {})
  assert.equal(nothing.ok, false)
  const stale = await host.call('approve-proposal', { work: id })
  assert.equal(stale.ok, false)
})
