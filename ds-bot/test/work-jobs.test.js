// A Bot that leaves a background job running and reports ready. The answer cannot be read
// yet, so the report is held and the work stays open until the job ends: then the Bot is
// woken once with the job's id, reads the result and reports again. A job the Bot killed
// before reporting leaves nothing to wake for.
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
  const views = new Map()
  const jobs = { get: id => views.get(id), list: () => [...views.values()] }
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
  const ctx = fakeContext({ services: { jobs, agents: { get: sessionId => agents.get(sessionId) } } })
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  rt.live.set('b', { turn: 7 })
  agentOf('b')
  await rt.teamTools.find(d => d.name === 'list_bots').execute({}, { agent: { id: 'a' } })
  const report = (args, sessionId = 'b') => rt.reportWork('w1', args, { agent: { id: sessionId } })
  return { rt, agents, views, emit, report, stop: async () => { await ctx.dispose() } }
}

function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-work-jobs-'))
  const hosts = []
  t.after(async () => {
    for (const host of hosts.reverse()) await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { start: async () => { const host = await startHost(home); hosts.push(host); return host } }
}

const startJob = (emit, views, id = 'j1') => {
  emit('b', 'job/registered', { jobId: id, startedAt: Date.now(), kind: 'bash', label: 'ssh gpu01 python train.py' })
  views.set(id, { status: 'running', output: { total: 0 } })
}

test('a ready report waits for the Bot own running job and is woken when it ends', async (t) => {
  const host = await bench(t).start()
  const { rt, agents, views, emit, report } = host
  rt.openWork('w1', { from: 'a', to: 'b' })
  startJob(emit, views)
  const held = report({ state: 'ready', summary: 'training is running in the background' })
  assert.deepEqual(held.held, ['j1'], 'the ready report is not final')
  assert.equal(held.report.state, 'progress')
  assert.equal(rt.workState('w1').state, 'working')
  assert.equal(agents.get('b').calls.length, 0, 'nothing wakes the Bot while the job runs')

  views.set('j1', { status: 'completed', output: { total: 10, spillPaths: ['/tmp/j1.out'] } })
  emit('b', 'job/settled', { jobId: 'j1', status: 'completed' })
  const calls = agents.get('b').calls
  assert.equal(calls.length, 1, 'one wake, not duplicates')
  assert.equal(calls[0][0], 'followup')
  const text = calls[0][1].content.map(block => block.text ?? '').join('\n')
  assert.match(text, /j1/, 'the wake names the job')
  assert.match(text, /\/tmp\/j1\.out/, 'the wake names the output file the job wrote')
  assert.equal(rt.workState('w1').state, 'working', 'the work stays open until it reports again')

  // The settlement cannot wake it a second time.
  emit('b', 'job/settled', { jobId: 'j1', status: 'completed' })
  assert.equal(agents.get('b').calls.length, 1)
})

test('a job that ends after the report is held for the whole list, then wakes once', async (t) => {
  const host = await bench(t).start()
  const { rt, agents, views, emit, report } = host
  rt.openWork('w1', { from: 'a', to: 'b' })
  startJob(emit, views, 'j1')
  startJob(emit, views, 'j2')
  const held = report({ state: 'ready', summary: 'two jobs are running' })
  assert.deepEqual(held.held.sort(), ['j1', 'j2'])
  emit('b', 'job/settled', { jobId: 'j1', status: 'completed' })
  assert.equal(agents.get('b').calls.length, 0, 'one of two jobs is still running')
  emit('b', 'job/settled', { jobId: 'j2', status: 'completed' })
  assert.equal(agents.get('b').calls.length, 1)
  assert.match(agents.get('b').calls[0][1].content.map(block => block.text ?? '').join('\n'), /j2/)
})

test('a job the Bot killed before reporting leaves a normal ready report', async (t) => {
  const host = await bench(t).start()
  const { rt, agents, views, emit, report } = host
  rt.openWork('w1', { from: 'a', to: 'b' })
  startJob(emit, views)
  emit('b', 'job/settled', { jobId: 'j1', status: 'killed' })
  const done = report({ state: 'ready', summary: 'stopped it on purpose' })
  assert.equal(done.held, undefined)
  assert.equal(done.report.state, 'ready')
  assert.equal(rt.workState('w1').state, 'person/review')
  assert.equal(agents.get('b').calls.length, 0, 'no wake for a job it stopped itself')
})

test('a job from an earlier turn does not hold a fresh report', async (t) => {
  const host = await bench(t).start()
  const { rt, agents, views, emit, report } = host
  rt.openWork('w1', { from: 'a', to: 'b' })
  startJob(emit, views, 'j-old')
  // The Bot moved on: this report answers a later turn.
  rt.live.set('b', { turn: 9 })
  const done = report({ state: 'ready', summary: 'done' })
  assert.equal(done.held, undefined)
  assert.equal(done.report.state, 'ready')
  assert.equal(agents.get('b').calls.length, 0)
})
