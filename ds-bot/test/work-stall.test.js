// The lease of a work that stopped reporting: it is marked stalled, the Bot that asked
// reads why at its next turn, and with the `redispatch` policy the task goes back to the
// Bot that held it — once, however often the sweep runs and whatever a restart leaves.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { LEASE_POLICY, STALL_MS, leasePolicyOf } from '../src/host/work-state.js'

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
  // A restart opens the team the last host saved, not a fresh one.
  if (!existsSync(join(home, 'state.json'))) writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
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

const settle = () => new Promise(resolve => setTimeout(resolve, 30))

const textOf = message => message.content.map(block => block.text ?? '').join('')

function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-work-stall-'))
  const hosts = []
  t.after(async () => {
    for (const host of hosts.reverse()) await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { home, start: async (config) => { const host = await startHost(home, config); hosts.push(host); return host } }
}

test('the lease policy defaults to notifying, and the config may change it', () => {
  assert.deepEqual(leasePolicyOf(), LEASE_POLICY)
  assert.equal(LEASE_POLICY.action, 'notify')
  assert.equal(LEASE_POLICY.deadline, STALL_MS)
  assert.deepEqual(leasePolicyOf({ leaseAction: 'redispatch', workDeadlineMinutes: 5 }),
    { action: 'redispatch', deadline: 5 * 60_000 })
  assert.deepEqual(leasePolicyOf({ leaseAction: 'shout', workDeadlineMinutes: -1 }), LEASE_POLICY)
})

test('a stalled work tells the Bot that asked, once', async (t) => {
  const { rt, agents } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  const at = Date.now() + STALL_MS + 60_000
  assert.equal(rt.sweepStalled(at), true)
  await settle()
  assert.equal(rt.workState('w1').state, 'person/blocked')
  assert.equal(rt.workState('w1').reason, 'no_progress')
  const calls = agents.get(rt.chatOf('a')).calls
  assert.equal(calls.length, 1, 'the asker is told once')
  const message = calls[0][1]
  assert.equal(message.source.role, 'stalled')
  assert.match(textOf(message), /^\[A work you handed on to Writer stalled\]/)
  assert.match(textOf(message), /did not report for \d+ min/)
  // The mark is what stops a second notice, not a second reading of the report.
  assert.equal(rt.sweepStalled(at + 60_000), false)
  await settle()
  assert.equal(agents.get(rt.chatOf('a')).calls.length, 1)
})

test('a report after a stall is a fresh lease, and a new stall is told again', async (t) => {
  const { rt, agents } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  rt.sweepStalled(Date.now() + STALL_MS + 60_000)
  await settle()
  assert.equal(rt.sweepStalled(Date.now()), false)
  assert.deepEqual(rt.reportWork('w1', { state: 'progress', summary: 'back on it' }).report.state, 'progress')
  assert.equal(rt.state.works.w1.stalled, undefined)
  const later = Date.now() + STALL_MS + 60_000
  assert.equal(rt.sweepStalled(later), true)
  await settle()
  assert.equal(agents.get(rt.chatOf('a')).calls.length, 2)
})

test('redispatch hands the task back once, and a restart does not send it again', async (t) => {
  const benchOf = bench(t)
  const first = await benchOf.start({ leaseAction: 'redispatch' })
  first.rt.state.exchanges.push({ id: 'w1', from: 'a', to: 'b', text: 'write the report', role: 'request', time: 1 })
  first.rt.openWork('w1', { from: 'a', to: 'b' })
  const at = Date.now() + STALL_MS + 60_000
  assert.equal(first.rt.sweepStalled(at), true)
  await settle()
  const back = first.agents.get(first.rt.chatOf('b')).calls
  assert.equal(back.length, 1, 'the task is handed back once')
  const message = back[0][1]
  assert.equal(message.source.role, 'request')
  assert.equal(message.source.exchangeId, 'w1')
  assert.match(textOf(message), /handed to you again/)
  assert.match(textOf(message), /write the report/)
  // The asker still hears about it.
  assert.equal(first.agents.get(first.rt.chatOf('a')).calls.length, 1)
  assert.equal(Object.keys(first.rt.state.requests).filter(key => key.includes('stall:w1')).length, 1)
  // The same sweep, or a stalled mark lost in a crash, must not run the task twice.
  assert.equal(first.rt.sweepStalled(at + 60_000), false)
  await first.stop()
  const second = await benchOf.start({ leaseAction: 'redispatch' })
  delete second.rt.state.works.w1.stalled
  delete second.rt.state.works.w1.report
  assert.equal(second.rt.sweepStalled(at + 60_000), true)
  await settle()
  assert.equal(second.agents.get(second.rt.chatOf('b'))?.calls.length ?? 0, 0, 'the receipt of the first send stops the second')
  assert.deepEqual(await second.rt.knownRequest(second.rt.requestIdentity({
    caller: 'a', context: 'lease', name: 'stall:w1', payload: { work: 'w1', text: 'write the report' },
  })), { status: 'replay', receipt: 'w1' })
})
