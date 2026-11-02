// A work whose Bot is waiting for a background job: while that job runs — and past its
// expected span, while it still writes — the silence is progress. Only a job that has
// gone silent past twice the expected span stops excusing the work.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { JOB_GRACE_MS, STALL_MS, jobInProgress } from '../src/host/work-state.js'

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
  // The jobs registry DSH would give the plugin: views by job id, as tool-jobs lists them.
  const views = new Map()
  const jobs = { get: id => views.get(id), list: () => [...views.values()] }
  const ctx = fakeContext({ services: { jobs } })
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
  const rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  await tool('list_bots', {}, 'a')
  return { rt, ctx, emit, views, stop: async () => { await ctx.dispose() } }
}

function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-stall-jobs-'))
  const hosts = []
  t.after(async () => {
    for (const host of hosts.reverse()) await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { start: async () => { const host = await startHost(home); hosts.push(host); return host } }
}

test('a live job keeps the work alive, and settles into the normal rule', async (t) => {
  const host = await bench(t).start()
  const { rt, emit, views } = host
  rt.openWork('w1', { from: 'a', to: 'b' })
  const at = Date.now() + STALL_MS + 60_000
  emit('b', 'job/registered', { jobId: 'j1', startedAt: at - 10 * 60_000, kind: 'bash', label: 'sleep 3h' })
  views.set('j1', { status: 'running', output: { total: 0 } })
  assert.equal(rt.sweepStalled(at), false, 'waiting for a job that is expected to run is progress')
  assert.equal(rt.workState('w1').state, 'working')
  // The job ends: nothing keeps the work alive any more.
  emit('b', 'job/settled', { jobId: 'j1' })
  assert.equal(rt.sweepStalled(at), true)
  assert.equal(rt.workState('w1').state, 'person/blocked')
})

test('a job that keeps writing past its expected span still counts as progress', async (t) => {
  const host = await bench(t).start()
  const { rt, emit, views } = host
  rt.openWork('w2', { from: 'a', to: 'b' })
  const at = Date.now() + STALL_MS + 60_000
  emit('b', 'job/registered', { jobId: 'j2', startedAt: at - 2 * 60 * 60_000, kind: 'bash', label: './run-experiment.sh' })
  // It has already written something; from here on, growth is what keeps it alive.
  views.set('j2', { status: 'running', output: { total: 10 } })
  assert.equal(rt.sweepStalled(at), false)
  views.set('j2', { status: 'running', output: { total: 20 } })
  const later = at + 30 * 60_000
  assert.equal(rt.sweepStalled(later), false, 'new output is progress however old the job is')
  // Silent past twice the expected span again: no longer progress.
  const silent = later + JOB_GRACE_MS + 60_000
  assert.equal(rt.sweepStalled(silent), true)
  assert.match(rt.workState('w2').summary, /background job has produced no output for \d+ min/)
})

test('a job that has been silent past twice its expected span does not excuse a stall', async (t) => {
  const host = await bench(t).start()
  const { rt, emit, views } = host
  rt.openWork('w3', { from: 'a', to: 'b' })
  const at = Date.now() + STALL_MS + 60_000
  emit('b', 'job/registered', { jobId: 'j3', startedAt: at - JOB_GRACE_MS - 60_000, kind: 'bash', label: 'sleep forever' })
  views.set('j3', { status: 'running', output: { total: 0 } })
  assert.equal(rt.sweepStalled(at), true, 'a stuck job must still be found')
  assert.match(rt.workState('w3').summary, /no progress for \d+ min; a background job has produced no output/)
})

test('a job in a group Session counts for its Bot too', async (t) => {
  const host = await bench(t).start()
  const { rt, emit, views } = host
  rt.openWork('w4', { from: 'a', to: 'b' })
  const at = Date.now() + STALL_MS + 60_000
  // The Bot works in a group's Session there; the job belongs to the Bot all the same.
  rt.groupOwners.set('gb', { roomId: 'r1', botId: 'b' })
  emit('gb', 'job/registered', { jobId: 'j4', startedAt: at - 5 * 60_000, kind: 'pwsh', label: 'Invoke-LongRun' })
  views.set('j4', { status: 'running', output: { total: 0 } })
  assert.equal(rt.sweepStalled(at), false)
  rt.groupOwners.delete('gb')
})

test('the job rule itself: expected while young, then only while it writes', () => {
  const at = 10 * JOB_GRACE_MS
  assert.equal(jobInProgress({ startedAt: at - 60_000 }, at), true)
  assert.equal(jobInProgress({ startedAt: at - JOB_GRACE_MS - 1 }, at), false)
  assert.equal(jobInProgress({ startedAt: 0, lastActivityAt: at - 60_000 }, at), true, 'recent output keeps it alive')
  assert.equal(jobInProgress({ startedAt: 0, lastActivityAt: at - JOB_GRACE_MS }, at), false)
  assert.equal(jobInProgress(undefined, at), false)
})

test('no job of the Bot means the old stall path, unchanged', async (t) => {
  const host = await bench(t).start()
  const { rt } = host
  rt.openWork('w5', { from: 'a', to: 'b' })
  const at = Date.now() + STALL_MS + 60_000
  assert.equal(rt.sweepStalled(at), true)
  assert.equal(rt.workState('w5').state, 'person/blocked')
  rt.openWork('w6', { from: 'a', to: 'b' })
  assert.equal(rt.sweepStalled(Date.now()), false, 'a young work is still young')
})

// The job events the registry appends carry a session id; the tracker reads them there.
test('a registered job names its session and kind', async (t) => {
  const host = await bench(t).start()
  const { rt, emit, views } = host
  emit('b', 'job/registered', { jobId: 'j5', startedAt: 1_000, kind: 'bash', label: 'sleep 1' })
  views.set('j5', { status: 'running', output: { total: 0 } })
  const [job] = rt.liveJobsOf('b')
  assert.deepEqual([job.id, job.sessionId, job.kind, job.label], ['j5', 'b', 'bash', 'sleep 1'])
  assert.deepEqual(rt.liveJobsOf('a'), [], 'another Bot has none of it')
})
