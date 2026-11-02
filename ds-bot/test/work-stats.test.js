// The least a piece of work leaves behind: how many rounds it took, how long it ran and
// what it ended as, in one read-only summary the panel can poll.
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
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  await tool('list_bots', {}, 'a')
  return { rt, ctx, emit, tool, call, stop: async () => { await ctx.dispose() } }
}

function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-work-stats-'))
  const hosts = []
  t.after(async () => {
    for (const host of hosts.reverse()) await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { start: async () => { const host = await startHost(home); hosts.push(host); return host } }
}

const textBlock = text => [{ type: 'text', text }]

test('a work leaves its rounds, its length and its final state', async (t) => {
  const { rt, emit } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b', authority: 'asked' })
  rt.state.works.w1.at = Date.now() - 90_000
  // The turn that answers the work: one round of it.
  emit(rt.chatOf('b'), 'turn/start', { turn: 1 })
  emit(rt.chatOf('b'), 'user/message', {
    content: textBlock('write it'),
    source: { kind: SOURCE_KIND, role: 'request', exchangeId: 'w1', senderSessionId: 'a', senderName: 'Chief' },
  })
  assert.equal(rt.state.works.w1.turns, 1)
  rt.closeWork('w1', 'Writer', 'Done.')
  const [entry] = rt.state.workLog
  assert.equal(entry.id, 'w1')
  assert.equal(entry.final, 'ready')
  assert.equal(entry.authority, 'asked')
  assert.equal(entry.turns, 1)
  assert.ok(entry.ms >= 90_000, `a work that ran 90 s keeps its length, got ${entry.ms}`)
  assert.ok(entry.closedAt >= entry.at)
})

test('a work that ends blocked or is dropped says so in the log', async (t) => {
  const { rt } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  rt.reportWork('w1', { state: 'blocked', summary: 'needs a key' })
  rt.closeWork('w1', 'Writer', 'Cannot go on.')
  assert.equal(rt.state.workLog.at(-1).final, 'blocked')
  assert.equal(rt.state.workLog.at(-1).summary, 'needs a key')
  rt.openWork('w2', { from: 'a', to: 'b' })
  rt.dropWork('w2')
  assert.equal(rt.state.workLog.at(-1).final, 'dropped')
})

test('workStats summarises the log and the open work without changing anything', async (t) => {
  const { rt } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  rt.state.works.w1.turns = 2
  rt.closeWork('w1', 'Writer', 'Done.')
  rt.openWork('w2', { from: 'a', to: 'b' })
  rt.dropWork('w2')
  rt.openWork('w3', { from: 'a', to: 'b' })
  const before = JSON.stringify(rt.state.workLog)
  const stats = rt.workStats()
  assert.equal(JSON.stringify(rt.state.workLog), before, 'reading the stats writes nothing')
  assert.equal(stats.closed, 2)
  assert.equal(stats.open, 1)
  assert.deepEqual(stats.byFinal, { ready: 1, dropped: 1 })
  assert.equal(stats.turns, 2)
  assert.ok(typeof stats.avgMs === 'number' && stats.avgMs >= 0)
})

test('the state payload carries the summary', async (t) => {
  const { rt, call } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  rt.closeWork('w1', 'Writer', 'Done.')
  const answer = await call('state', {})
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.value.workStats, { closed: 1, open: 0, byFinal: { ready: 1 }, turns: 0, avgMs: answer.value.workStats.avgMs })
  assert.ok(typeof answer.value.workStats.avgMs === 'number')
})
