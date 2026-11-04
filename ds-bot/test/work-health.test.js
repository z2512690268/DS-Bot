// The two questions the panel answers beside "what needs me now": whether anything is
// wrong right now, and what happened to one piece of work from its start to its end.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { STALL_MS } from '../src/host/work-state.js'

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
  return { rt, tool, call, stop: async () => { await ctx.dispose() } }
}

function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-work-health-'))
  const hosts = []
  t.after(async () => {
    for (const host of hosts.reverse()) await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { start: async () => { const host = await startHost(home); hosts.push(host); return host } }
}

test('a healthy team reports zero of everything', async (t) => {
  const { rt, call } = await bench(t).start()
  assert.deepEqual(rt.workHealth(), { stalled: 0, deliveryFailures: 0, answerFailures: 0, retries: 0, retryFailures: 0 })
  const answer = await call('state', {})
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.value.workHealth, { stalled: 0, deliveryFailures: 0, answerFailures: 0, retries: 0, retryFailures: 0 })
})

test('the health line counts stalled work and failed answers', async (t) => {
  const { rt } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  rt.sweepStalled(Date.now() + STALL_MS + 60_000)
  rt.answerMissed('w1')
  assert.deepEqual(rt.workHealth(), { stalled: 1, deliveryFailures: 0, answerFailures: 1, retries: 0, retryFailures: 0 })
})

test('a delivery that failed is counted, and an old one is not news', async (t) => {
  const { rt, tool } = await bench(t).start()
  const deliver = rt.deliver
  rt.deliver = async () => { throw new Error('the Session is gone') }
  await assert.rejects(tool('message_bot', { to: 'Writer', message: 'write it' }, 'a'), /Session is gone/)
  rt.deliver = deliver
  assert.equal(rt.workHealth().deliveryFailures, 1)
  // The health question is about now: a failure from two hours ago is not shown.
  rt.state.workFaults.delivery.push(Date.now() - 2 * 60 * 60_000)
  assert.equal(rt.workHealth().deliveryFailures, 1)
  rt.state.workFaults.delivery.splice(0, 1)
  assert.equal(rt.workHealth().deliveryFailures, 0)
})

test('a work keeps its timeline while it is open and after it is answered', async (t) => {
  const { rt } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b', authority: 'asked' })
  rt.reportWork('w1', { state: 'progress', summary: 'reading the file' })
  rt.reportWork('w1', { state: 'blocked', summary: 'needs a key' })
  assert.deepEqual(rt.workHistory('w1').map(event => event.event), ['created', 'progress', 'blocked'])
  const item = rt.needsYou().find(entry => entry.work === 'w1')
  assert.deepEqual(item.history.map(event => event.event), ['created', 'progress', 'blocked'])
  rt.closeWork('w1', 'Writer', 'Cannot read it.')
  const closed = rt.workHistory('w1')
  assert.deepEqual(closed.map(event => event.event), ['created', 'progress', 'blocked', 'closed'])
  assert.equal(closed[0].authority, 'asked')
  assert.equal(closed.at(-1).final, 'blocked')
  assert.ok(closed.every((event, at) => at === 0 || event.at >= closed[at - 1].at))
})

test('a dismissed stall leaves the health line and the team file', async (t) => {
  const { rt } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  rt.sweepStalled(Date.now() + STALL_MS + 60_000)
  assert.equal(rt.workHealth().stalled, 1)
  assert.deepEqual(rt.needsYou().map(item => item.kind), ['blocked'])
  const result = rt.dismissNeeds(['blocked:w1'])
  assert.deepEqual(result, { dismissed: 1, dropped: 1 })
  assert.equal(rt.workHealth().stalled, 0, 'a dismissed stall is not unhealthy any more')
  assert.equal(rt.state.works.w1, undefined, 'and it does not sit in the team file for good')
  assert.equal(rt.state.workLog.at(-1).final, 'blocked')
  // The panel may send the same dismissal twice; the second one drops nothing.
  assert.deepEqual(rt.dismissNeeds(['blocked:w1']), { dismissed: 1, dropped: 0 })
})

test('a stall dismissed before the cleanup existed is cleared by the next sweep', async (t) => {
  const { rt } = await bench(t).start()
  rt.openWork('gone', { from: 'a', to: 'b' })
  rt.openWork('kept', { from: 'a', to: 'b' })
  const at = Date.now() + STALL_MS + 60_000
  rt.sweepStalled(at)
  assert.equal(rt.workHealth().stalled, 2)
  // A state from before the sweep cleaned up: the row was dismissed, the work stayed.
  rt.state.dismissed = { 'blocked:gone': at }
  assert.equal(rt.workHealth().stalled, 1, 'a dismissed stall is not unhealthy')
  // A stalled work that handed something on is hidden too, not cleared while that runs.
  rt.openWork('parent', { from: 'a', to: 'b' })
  rt.openWork('child', { from: 'b', to: 'a', parent: 'parent' })
  rt.state.works.child.lease = { at, by: 'a' }
  rt.reportWork('parent', { state: 'blocked', summary: 'no progress for 40 min', next: 'Chief decides' })
  rt.state.works.parent.report.stalled = true
  rt.state.works.parent.stalled = { at, action: 'notify' }
  rt.state.dismissed['blocked:parent'] = at
  assert.equal(rt.sweepStalled(at + 60_000), true)
  assert.equal(rt.state.works.gone, undefined, 'the dismissed stall is cleared')
  assert.equal(rt.state.workLog.at(-1).id, 'gone')
  assert.ok(rt.state.works.kept, 'the work the user did not dismiss stays')
  assert.ok(rt.state.works.parent, 'and a stalled parent of live work stays')
  assert.equal(rt.workHealth().stalled, 1, 'only the work the user did not dismiss is a stall')
  // Nothing left to clear: a second sweep is quiet.
  assert.equal(rt.sweepStalled(at + 120_000), false)
})

test('a work that is still running is hidden, never dropped', async (t) => {
  const { rt } = await bench(t).start()
  rt.openWork('live', { from: 'a', to: 'b' })
  assert.deepEqual(rt.dismissNeeds(['blocked:live']), { dismissed: 1, dropped: 0 })
  assert.ok(rt.state.works.live, 'a running work stays, only its row is hidden')
  assert.deepEqual(rt.needsYou(), [])
  assert.equal(rt.workHealth().stalled, 0)
  // A stalled work that handed on work of its own is hidden too, but not dropped while
  // that work is still out.
  rt.openWork('parent', { from: 'a', to: 'b' })
  rt.openWork('child', { from: 'b', to: 'a', parent: 'parent' })
  rt.reportWork('parent', { state: 'blocked', summary: 'no progress for 40 min', next: 'Chief decides' })
  rt.state.works.parent.report.stalled = true
  rt.state.works.parent.stalled = { at: Date.now(), action: 'notify' }
  assert.equal(rt.workHealth().stalled, 1)
  assert.deepEqual(rt.dismissNeeds(['blocked:parent']), { dismissed: 1, dropped: 0 })
  assert.ok(rt.state.works.parent, 'the parent of live work is not dropped')
  assert.equal(rt.workHealth().stalled, 0)
})

test('a stall and a proposal each leave their own line in the history', async (t) => {
  const { rt } = await bench(t).start()
  const proposal = rt.proposeWork({ from: 'a', to: 'b', text: 'rewrite the changelog' })
  assert.deepEqual(rt.workHistory(proposal).map(event => event.event), ['proposed'])
  assert.equal(rt.workHistory(proposal)[0].text, 'rewrite the changelog')
  rt.openWork('w2', { from: 'a', to: 'b' })
  rt.sweepStalled(Date.now() + STALL_MS + 60_000)
  assert.deepEqual(rt.workHistory('w2').map(event => event.event), ['created', 'stalled'])
  assert.equal(rt.workHistory('nope').length, 0)
})
