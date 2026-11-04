// A model request that failed because the provider was busy, the connection dropped or
// the completion came back empty: waited out and retried inside the same open turn, so
// the work is not lost to a hiccup. A refused key, an exhausted quota or a malformed
// request is not retried — it is reported at once with what the provider said.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { llmRetryOf, reportableFailure, retryDelayOf, retryableFailure } from '../src/host/work-state.js'

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
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  const agents = new Map()
  const diagnostics = []
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
  // Diagnostics go through noteFailure; keep them where the test can read them.
  const noteFailure = rt.noteFailure
  rt.noteFailure = (entry) => { diagnostics.push(entry); return noteFailure?.(entry) }
  return { rt, ctx, agents, tool, diagnostics, stop: async () => { await ctx.dispose() } }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 30))
const textOf = message => message.content.map(block => block.text ?? '').join('')
const callsOf = (agents, sessionId) => agents.get(sessionId)?.calls ?? []

function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-llm-retry-'))
  const hosts = []
  t.after(async () => {
    for (const host of hosts.reverse()) await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { home, start: async (config) => { const host = await startHost(home, config); hosts.push(host); return host } }
}

const overload = (turn = 1, step = 2) => ({
  agent: { id: 'b' },
  turn,
  step,
  failure: { code: 'PI_AI_ERROR', message: 'servers overloaded' },
  signal: new AbortController().signal,
})

test('the retry policy is three tries from five seconds, and both are configurable', () => {
  assert.deepEqual(llmRetryOf(), { attempts: 3, baseMs: 5000 })
  assert.deepEqual(llmRetryOf({ llmRetryAttempts: 5, llmRetryBaseSeconds: 2 }), { attempts: 5, baseMs: 2000 })
  assert.deepEqual(llmRetryOf({ llmRetryAttempts: 0 }), { attempts: 0, baseMs: 5000 })
  assert.deepEqual(llmRetryOf({ llmRetryAttempts: -1, llmRetryBaseSeconds: 'x' }), { attempts: 3, baseMs: 5000 })
})

test('only a transient failure is worth another attempt', () => {
  for (const code of ['TRANSPORT', 'SERVER', 'RATE_LIMIT', 'TIMEOUT', 'EMPTY_RESPONSE']) {
    assert.equal(retryableFailure({ code }), true, code)
  }
  // pi-ai reports an overloaded provider as PI_AI_ERROR: the wording says it is transient.
  assert.equal(retryableFailure({ code: 'PI_AI_ERROR', message: 'servers overloaded' }), true)
  assert.equal(retryableFailure({ code: 'PI_AI_ERROR', message: 'pi-ai deferred response for model x' }), false)
  for (const code of ['AUTH', 'QUOTA', 'ACCOUNT_QUOTA', 'INVALID_REQUEST', 'INVALID_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED', 'ABORTED']) {
    assert.equal(retryableFailure({ code }), false, code)
  }
  assert.equal(reportableFailure({ code: 'AUTH' }), true)
  assert.equal(reportableFailure({ code: 'ACCOUNT_QUOTA' }), true)
  assert.equal(reportableFailure({ code: 'TRANSPORT' }), false)
})

test('the backoff is 1x, 3x, 9x with ten percent jitter', () => {
  assert.equal(retryDelayOf(1, 5000, () => 0.5), 5000)
  assert.equal(retryDelayOf(2, 5000, () => 0.5), 15000)
  assert.equal(retryDelayOf(3, 5000, () => 0.5), 45000)
  assert.equal(retryDelayOf(1, 5000, () => 0), 4500)
  assert.equal(retryDelayOf(1, 5000, () => 1), 5500)
})

test('an overloaded model is retried three times and the turn goes on', async (t) => {
  const { rt, diagnostics } = await bench(t).start({ llmRetryBaseSeconds: 0.01 })
  const payload = overload()
  // 10 ms base: the waits back off 1x, 3x, 9x with ten percent jitter.
  const windows = [[9, 11], [27, 33], [81, 99]]
  for (const attempt of [1, 2, 3]) {
    assert.deepEqual(await rt.recoverRequest(payload, async () => undefined), { kind: 'retry' })
    const entry = rt.llmRetryAudit().at(-1)
    assert.equal(entry.attempt, attempt)
    assert.equal(entry.code, 'PI_AI_ERROR')
    assert.equal(entry.outcome, 'retry')
    const [low, high] = windows[attempt - 1]
    assert.ok(entry.delayMs >= low && entry.delayMs <= high, `attempt ${attempt} waits ${entry.delayMs} ms`)
  }
  // The retry re-runs the same step, so this step is still the same budget: one more
  // failure is the end of the budget, not a fourth retry.
  assert.equal(await rt.recoverRequest(payload, async () => undefined), undefined)
  assert.equal(rt.llmRetryAudit().filter(entry => entry.outcome === 'retry').length, 3)
  // A later step starts with a fresh budget, so one hiccup does not use up the next.
  assert.deepEqual(await rt.recoverRequest(overload(1, 5), async () => undefined), { kind: 'retry' })
  assert.equal(rt.llmRetryView().retries, 4)
  // Every wait is in the diagnostics log with the attempt, the code and the delay; the
  // exhausted budget leaves its own line.
  const retries = diagnostics.filter(entry => entry.source === 'retry')
  assert.equal(retries.filter(entry => /retry \d+\/3 in \d+ ms \(PI_AI_ERROR\)/.test(entry.text)).length, 4)
  assert.equal(retries.filter(entry => /failed after 3 retries/.test(entry.text)).length, 1)
})

test('the model failing for good marks the work failed and tells the Bot that asked', async (t) => {
  const { rt, agents } = await bench(t).start({ llmRetryBaseSeconds: 0.01 })
  rt.openWork('w1', { from: 'a', to: 'b' })
  const payload = overload()
  for (let at = 0; at < 3; at += 1) await rt.recoverRequest(payload, async () => undefined)
  assert.equal(await rt.recoverRequest(payload, async () => undefined), undefined)
  await settle()
  assert.equal(rt.state.works.w1.report.state, 'failed')
  assert.match(rt.state.works.w1.report.summary, /after 3 retries \(PI_AI_ERROR: servers overloaded\)/)
  assert.equal(rt.state.works.w1.halted.reason, 'llm-failed')
  const told = callsOf(agents, rt.chatOf('a'))
  assert.equal(told.length, 1)
  assert.equal(told[0][1].source.role, 'work-failed')
  assert.match(textOf(told[0][1]), /^\[A work you handed on to Writer could not be answered\]/)
  assert.match(textOf(told[0][1]), /servers overloaded/)
  assert.equal(rt.llmRetryView().retryFailures, 1)
  // The chain watchdog leaves it alone: the same route would only fail again.
  assert.equal(rt.sweepResume(Date.now() + 10 * 60_000), false)
  await settle()
  assert.equal(callsOf(agents, rt.chatOf('b')).length, 0)
})

test('a refused key, a quota or a bad request is reported at once, never retried', async (t) => {
  const { rt, agents, diagnostics } = await bench(t).start({ llmRetryBaseSeconds: 0.01 })
  rt.openWork('w1', { from: 'a', to: 'b' })
  for (const failure of [{ code: 'AUTH', status: 401 }, { code: 'ACCOUNT_QUOTA' }, { code: 'INVALID_REQUEST' }]) {
    const result = await rt.recoverRequest({ ...overload(), failure }, async () => undefined)
    assert.equal(result, undefined)
  }
  assert.equal(rt.llmRetryAudit().filter(entry => entry.outcome === 'retry').length, 0)
  assert.equal(rt.state.works.w1.report.state, 'failed')
  await settle()
  const told = callsOf(agents, rt.chatOf('a'))
  assert.equal(told.length, 1, 'the failure is told once, not once per refusal')
  assert.match(textOf(told[0][1]), /could not be answered/)
  assert.ok(diagnostics.some(entry => /refused \(AUTH\)/.test(entry.text) && /not retried/.test(entry.text)))
})

test('a decision made downstream wins, and nothing is counted for it', async (t) => {
  const { rt } = await bench(t).start({ llmRetryBaseSeconds: 0.01 })
  const decision = await rt.recoverRequest(overload(), async () => ({ kind: 'retry' }))
  assert.deepEqual(decision, { kind: 'retry' })
  assert.equal(rt.llmRetryAudit().length, 0, 'the provider policy already retried; this layer stays out')
})

test('retrying is off when the attempt budget is zero', async (t) => {
  const { rt } = await bench(t).start({ llmRetryAttempts: 0 })
  rt.openWork('w1', { from: 'a', to: 'b' })
  assert.deepEqual(llmRetryOf(rt.config), { attempts: 0, baseMs: 5000 })
  assert.equal(await rt.recoverRequest(overload(), async () => undefined), undefined)
  assert.equal(rt.llmRetryAudit().filter(entry => entry.outcome === 'retry').length, 0)
  assert.equal(rt.state.works.w1.report.state, 'failed')
})

test('waiting for a retry is not a stopped chain', async (t) => {
  const { rt, agents } = await bench(t).start({ llmRetryBaseSeconds: 0.05 })
  rt.openWork('w1', { from: 'a', to: 'b' })
  // The retry runs inside the open turn; the turn is what the watchdog looks at.
  rt.live.set('b', { turn: { info: undefined }, since: Date.now() })
  const pending = rt.recoverRequest(overload(), async () => undefined)
  await settle()
  rt.sweepResume(Date.now() + 10 * 60_000)
  assert.equal(rt.state.works.w1.resume?.attempts ?? 0, 0, 'the watchdog takes the open turn for work')
  assert.equal(callsOf(agents, rt.chatOf('b')).length, 0, 'no continuation is injected while the turn is open')
  rt.live.delete('b')
  assert.deepEqual(await pending, { kind: 'retry' })
  assert.equal(rt.state.works.w1.halted, undefined, 'and the work is not marked stopped')
})

test('the health line counts retries and final failures in the last hour', async (t) => {
  const { rt } = await bench(t).start({ llmRetryBaseSeconds: 0.01 })
  await rt.recoverRequest(overload(1, 1), async () => undefined)
  await rt.recoverRequest(overload(1, 2), async () => undefined)
  assert.deepEqual(rt.llmRetryView(), { retries: 2, retryFailures: 0 })
  assert.equal(rt.workHealth().retries, 2)
  assert.equal(rt.workHealth().retryFailures, 0)
  // Older than the window: not "now".
  rt.state.llmRetries[0].at = Date.now() - 2 * 60 * 60_000
  assert.equal(rt.llmRetryView().retries, 1)
})
