// The inbox the panel reads: one list of what waits for the user, each row with the key
// the panel sends back to ignore it, and one request that clears several rows at once.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

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
  return { rt, state: rt.state, call, stop: async () => { await ctx.dispose() } }
}

function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-needs-inbox-'))
  const hosts = []
  t.after(async () => {
    for (const host of hosts.reverse()) await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { start: async () => { const host = await startHost(home); hosts.push(host); return host } }
}

const kinds = items => items.map(item => item.kind).sort()

test('every row carries the key the panel sends back', async (t) => {
  const { rt, state } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  rt.reportWork('w1', { state: 'blocked', summary: 'needs a key' })
  state.questions[rt.chatOf('b')] = { id: 'q1', question: '哪个方向？', askedAt: 5 }
  const items = rt.needsYou()
  assert.deepEqual(kinds(items), ['answer', 'blocked'])
  assert.equal(items.find(item => item.kind === 'answer').key, 'answer:q1')
  assert.equal(items.find(item => item.kind === 'blocked').key, 'blocked:w1')
})

test('ignoring several works at once hides them, and a proposal is dropped for good', async (t) => {
  const { rt } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  rt.reportWork('w1', { state: 'blocked', summary: 'needs a key' })
  const proposal = rt.proposeWork({ from: 'a', to: 'b', text: 'rewrite the changelog' })
  assert.deepEqual(kinds(rt.needsYou()), ['blocked', 'proposed'])
  const result = rt.dismissNeeds(['blocked:w1', `proposed:${proposal}`])
  assert.deepEqual(result, { dismissed: 2, dropped: 1 })
  assert.deepEqual(rt.needsYou(), [], 'the whole inbox is clear')
  assert.equal(rt.state.works[proposal], undefined, 'an ignored proposal is gone')
  assert.ok(rt.state.works.w1, 'a blocked work is still there, only hidden')
  assert.equal(rt.state.workLog.at(-1).final, 'dropped')
})

test('a work that moves on is news again, and unknown keys are ignored', async (t) => {
  const { rt } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  rt.reportWork('w1', { state: 'blocked', summary: 'needs a key' })
  const dismissed = Date.now()
  rt.dismissNeeds(['blocked:w1', 'nonsense:w1', 'answer:none'])
  assert.deepEqual(rt.needsYou(), [])
  await new Promise(resolve => setTimeout(resolve, 5))
  rt.reportWork('w1', { state: 'failed', summary: 'cannot read it' })
  assert.ok(rt.state.works.w1.report.at > dismissed)
  const items = rt.needsYou()
  assert.deepEqual(kinds(items), ['blocked'])
  assert.equal(items[0].summary, 'cannot read it')
})

test('dismissing the same item again is not an error', async (t) => {
  const { rt, call } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  rt.reportWork('w1', { state: 'blocked', summary: 'needs a key' })
  const first = await call('needs-dismiss', { keys: ['blocked:w1'] })
  const second = await call('needs-dismiss', { keys: ['blocked:w1'] })
  assert.deepEqual([first.ok, second.ok], [true, true])
  assert.deepEqual(rt.needsYou(), [])
  // A row that is already gone may still be dismissed: the panel cannot know.
  assert.equal((await call('needs-dismiss', { keys: ['blocked:nope'] })).ok, true)
})

test('the panel clears a whole inbox in one request', async (t) => {
  const { rt, call } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  rt.reportWork('w1', { state: 'blocked', summary: 'needs a key' })
  rt.openWork('w2', { from: 'b', to: 'a' })
  rt.reportWork('w2', { state: 'failed', summary: 'cannot read it' })
  const answer = await call('needs-dismiss', { keys: ['blocked:w1', 'blocked:w2'] })
  assert.deepEqual([answer.ok, answer.value], [true, { dismissed: 2, dropped: 0 }])
  assert.deepEqual(rt.needsYou(), [])
  const nothing = await call('needs-dismiss', { keys: [] })
  assert.equal(nothing.ok, false)
})
