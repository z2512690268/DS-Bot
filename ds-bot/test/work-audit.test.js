// The Main Bot's own work: each of its turns is audited, and a turn that keeps running
// past the soft or hard time line is interrupted — unless it says why the work must be
// its own. A repeat limit on one tool and one target catches doing a Bot's work for it.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { mainGateOf } from '../src/host/work-state.js'
import { WORK_GATE, toolTargetOf } from '../src/host/work-audit.js'

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], admin: 'a', seq: 0 } },
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
      const calls = []
      const cancelled = []
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined },
        id: sessionId,
        calls,
        cancelled,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel(cause) { cancelled.push(cause) },
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
      prompt: async () => {},
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home, ...config })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }) }),
  )).json()
  await tool('list_bots', {}, 'a')
  return { rt, ctx, agents, emit, tool, call, stop: async () => { await ctx.dispose() } }
}

function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-work-audit-'))
  const hosts = []
  t.after(async () => {
    for (const host of hosts.reverse()) await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { start: async (config) => { const host = await startHost(home, config); hosts.push(host); return host } }
}

const textOf = message => message.content.map(block => block.text ?? '').join('')
const settle = () => new Promise(resolve => setTimeout(resolve, 30))

function toolCall(host, sessionId, at, name = 'bash', args = {}) {
  host.emit(sessionId, 'tool/call', { callId: `c${at}`, name, arguments: JSON.stringify(args) })
  host.emit(sessionId, 'tool/result', { callId: `c${at}` })
}

const agentAt = (host, id) => host.agents.get(host.rt.chatOf(id))
const cancelledAt = (host, id) => agentAt(host, id)?.cancelled ?? []
const lastNotice = (host, id) => agentAt(host, id)?.calls.at(-1)

test('the repeat target is the host, path or service a call names', () => {
  assert.equal(toolTargetOf('bash', { command: 'ssh root@gpu1 uptime' }), 'host:gpu1')
  assert.equal(toolTargetOf('bash', { command: 'ssh -p 2222 root@gpu1 uptime' }), 'host:gpu1')
  assert.equal(toolTargetOf('bash', { command: 'scp file root@gpu1:/tmp/x' }), 'host:gpu1')
  assert.equal(toolTargetOf('bash', { command: 'curl https://example.com/x' }), 'url:example.com')
  assert.equal(toolTargetOf('bash', { command: 'systemctl restart nginx' }), 'service:nginx')
  assert.equal(toolTargetOf('bash', { command: 'cd /srv/app && npm test' }), 'path:/srv/app')
  assert.equal(toolTargetOf('read', { file_path: '/tmp/x' }), 'path:/tmp/x')
  assert.equal(toolTargetOf('message_bot', { to: 'Writer', message: 'do it' }), undefined)
  assert.equal(toolTargetOf('bash', { command: 'ls -la' }), undefined)
})

test('the gate defaults to enforce, a 45-second soft line and a 120-second hard line', () => {
  assert.deepEqual(mainGateOf(), { mode: 'enforce', softSeconds: 45, hardSeconds: 120, sameTarget: 4 })
  assert.deepEqual(mainGateOf({ mainWorkGate: 'audit', mainTurnSoftSeconds: 10, mainTurnHardSeconds: 20, mainWorkSameTarget: 2 }),
    { mode: 'audit', softSeconds: 10, hardSeconds: 20, sameTarget: 2 })
  assert.deepEqual(mainGateOf({ mainWorkGate: 'sometimes', mainTurnSoftSeconds: -1, mainTurnHardSeconds: 0, mainWorkSameTarget: 0 }),
    { mode: 'enforce', softSeconds: 45, hardSeconds: 120, sameTarget: 4 })
})

test('the soft line steers a reflection into the running turn and does not stop it', async (t) => {
  const host = await bench(t).start()
  let clock = 1_000
  host.rt.monotonicNow = () => clock
  host.emit('a', 'turn/start', { turn: 1 })
  toolCall(host, 'a', 0)
  toolCall(host, 'a', 1)
  clock += 45_000
  assert.equal(host.rt.sweepWorkGate(), true)
  await settle()
  assert.deepEqual(cancelledAt(host, 'a'), [], 'the soft line does not stop the turn')
  const notice = lastNotice(host, 'a')
  assert.equal(notice[0], 'steer', 'the reflection cuts into the running turn')
  assert.match(textOf(notice[1]), /^\[A check on this turn\]/)
  assert.match(textOf(notice[1]), /running 45 sec/)
  assert.match(textOf(notice[1]), /2 tool calls/)
  assert.match(textOf(notice[1]), /hand it on, narrow it, or call keep_working/)
  // It is asked once, not on every sweep.
  const before = agentAt(host, 'a').calls.length
  assert.equal(host.rt.sweepWorkGate(), false)
  await settle()
  assert.equal(agentAt(host, 'a').calls.length, before)
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const entry = host.rt.state.mainTurns.at(-1)
  assert.equal(entry.gated, undefined, 'a soft check is not a stop')
  assert.equal(entry.gates.length, 1)
  assert.equal(entry.gates[0].gate, 'soft')
  assert.equal(entry.gates[0].seconds, 45)
  assert.equal(entry.gates[0].tools, 2)
  assert.equal(entry.gates[0].dispatched, false)
  assert.match(entry.gates[0].text, /running 45 sec/)
})

test('the hard line stops the turn and tells the Bot how to answer the user', async (t) => {
  const host = await bench(t).start()
  let clock = 0
  host.rt.monotonicNow = () => clock
  host.emit('a', 'turn/start', { turn: 1 })
  toolCall(host, 'a', 0)
  clock = 120_000 + 1
  assert.equal(host.rt.sweepWorkGate(), true)
  await settle()
  assert.deepEqual(cancelledAt(host, 'a'), [{ kind: 'hook', reason: WORK_GATE }])
  const notice = lastNotice(host, 'a')
  assert.equal(notice[0], 'followup')
  assert.match(textOf(notice[1]), /^\[DS Bot stopped this turn\]/)
  assert.match(textOf(notice[1]), /passed 120 sec and was stopped/)
  assert.match(textOf(notice[1]), /keep_working/)
  assert.match(textOf(notice[1]), /已停手，等你指令/)
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  const entry = host.rt.state.mainTurns.at(-1)
  assert.equal(entry.gated, true)
  assert.equal(entry.gates.length, 1)
  assert.equal(entry.gates[0].gate, 'hard')
  assert.equal(entry.gates[0].seconds, 120)
  assert.equal(entry.gates[0].limit, 120)
  assert.equal(entry.gates[0].tools, 1)
  assert.equal(entry.gates[0].dispatched, false)
  assert.match(entry.gates[0].text, /已停手/)
})

test('the hard line interrupts a tool that has not returned yet', async (t) => {
  const host = await bench(t).start()
  let clock = 0
  host.rt.monotonicNow = () => clock
  host.emit('a', 'turn/start', { turn: 1 })
  host.emit('a', 'tool/call', { callId: 'slow', name: 'bash', arguments: JSON.stringify({ command: 'ssh gpu1 sleep 300' }) })
  // No tool/result: the gate must not wait for the long command to return.
  clock = 120_000 + 1
  assert.equal(host.rt.sweepWorkGate(), true)
  await settle()
  assert.deepEqual(cancelledAt(host, 'a'), [{ kind: 'hook', reason: WORK_GATE }])
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  const entry = host.rt.state.mainTurns.at(-1)
  assert.equal(entry.gates[0].gate, 'hard')
  assert.equal(entry.gates[0].seconds, 120)
})

test('a turn that handed work on is still stopped at the hard line', async (t) => {
  const host = await bench(t).start()
  let clock = 0
  host.rt.monotonicNow = () => clock
  host.emit('a', 'turn/start', { turn: 1 })
  assert.match(await host.tool('message_bot', { to: 'Writer', message: 'do it' }, 'a'), /Delivered to Writer/)
  clock = 120_000 + 1
  assert.equal(host.rt.sweepWorkGate(), true)
  await settle()
  assert.deepEqual(cancelledAt(host, 'a'), [{ kind: 'hook', reason: WORK_GATE }])
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  const entry = host.rt.state.mainTurns.at(-1)
  assert.equal(entry.works, 1)
  assert.equal(entry.gates[0].gate, 'hard')
  assert.equal(entry.gates[0].dispatched, true)
})

test('keep_working turns off the remaining time gates for the turn', async (t) => {
  const host = await bench(t).start()
  let clock = 0
  host.rt.monotonicNow = () => clock
  host.emit('a', 'turn/start', { turn: 1 })
  clock = 45_000 + 1
  host.rt.sweepWorkGate()
  await settle()
  assert.match(await host.tool('keep_working', { reason: '用户明确要求我直接查这台机器' }, 'a'), /Recorded/)
  clock = 5 * 60_000
  assert.equal(host.rt.sweepWorkGate(), false)
  await settle()
  assert.deepEqual(cancelledAt(host, 'a'), [])
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const entry = host.rt.state.mainTurns.at(-1)
  assert.equal(entry.kept, '用户明确要求我直接查这台机器')
  assert.equal(entry.gated, undefined)
  assert.equal(entry.gates[0].gate, 'soft')
})

test('keep_working after a hard stop links its reason to the gate', async (t) => {
  const host = await bench(t).start()
  let clock = 0
  host.rt.monotonicNow = () => clock
  host.emit('a', 'turn/start', { turn: 1 })
  clock = 120_000 + 1
  host.rt.sweepWorkGate()
  await settle()
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  host.emit('a', 'turn/start', { turn: 2 })
  assert.match(await host.tool('keep_working', { reason: '必须我继续' }, 'a'), /Recorded/)
  host.emit('a', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  const entries = host.rt.state.mainTurns
  assert.equal(entries.at(-2).gated, true)
  assert.equal(entries.at(-1).kept, '必须我继续')
  assert.equal(entries.at(-1).keptFrom, 'hard')
})

test('the same tool on the same target stops at the fourth call', async (t) => {
  const host = await bench(t).start()
  host.rt.monotonicNow = () => 0
  host.emit('a', 'turn/start', { turn: 1 })
  for (let at = 0; at < 3; at += 1) toolCall(host, 'a', at, 'bash', { command: 'ssh root@gpu1 uptime' })
  await settle()
  assert.deepEqual(cancelledAt(host, 'a'), [])
  toolCall(host, 'a', 3, 'bash', { command: 'ssh root@gpu1 nvidia-smi' })
  await settle()
  assert.deepEqual(cancelledAt(host, 'a'), [{ kind: 'hook', reason: WORK_GATE }])
  const notice = lastNotice(host, 'a')
  assert.match(textOf(notice[1]), /^\[DS Bot stopped this turn\]/)
  assert.match(textOf(notice[1]), /bash on host:gpu1 4 times/)
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  const entry = host.rt.state.mainTurns.at(-1)
  assert.equal(entry.gated, true)
  assert.equal(entry.gates[0].gate, 'same-target')
  assert.deepEqual(
    [entry.gates[0].tool, entry.gates[0].target, entry.gates[0].count, entry.gates[0].threshold],
    ['bash', 'host:gpu1', 4, 4],
  )
  assert.equal(entry.gates[0].dispatched, false)
})

test('the time thresholds are configurable', async (t) => {
  const host = await bench(t).start({ mainTurnSoftSeconds: 10, mainTurnHardSeconds: 20 })
  let clock = 0
  host.rt.monotonicNow = () => clock
  host.emit('a', 'turn/start', { turn: 1 })
  clock = 10_000
  assert.equal(host.rt.sweepWorkGate(), true)
  await settle()
  assert.deepEqual(cancelledAt(host, 'a'), [])
  clock = 20_000
  assert.equal(host.rt.sweepWorkGate(), true)
  await settle()
  assert.deepEqual(cancelledAt(host, 'a'), [{ kind: 'hook', reason: WORK_GATE }])
})

test('the repeat limit is configurable', async (t) => {
  const host = await bench(t).start({ mainWorkSameTarget: 2 })
  host.rt.monotonicNow = () => 0
  host.emit('a', 'turn/start', { turn: 1 })
  toolCall(host, 'a', 0, 'bash', { command: 'ssh gpu1 uptime' })
  toolCall(host, 'a', 1, 'bash', { command: 'ssh gpu1 uptime' })
  await settle()
  assert.deepEqual(cancelledAt(host, 'a'), [{ kind: 'hook', reason: WORK_GATE }])
})

test('audit mode records the time gates without stopping; off records nothing', async (t) => {
  const auditHost = await bench(t).start({ mainWorkGate: 'audit' })
  let clock = 0
  auditHost.rt.monotonicNow = () => clock
  auditHost.emit('a', 'turn/start', { turn: 1 })
  clock = 120_000 + 1
  assert.equal(auditHost.rt.sweepWorkGate(), true)
  await settle()
  assert.deepEqual(cancelledAt(auditHost, 'a'), [])
  auditHost.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const audited = auditHost.rt.state.mainTurns.at(-1)
  assert.equal(audited.gated, undefined, 'audit mode does not stop')
  assert.equal(audited.gates[0].gate, 'hard')
  assert.deepEqual(auditHost.rt.workAudit(), { turns: 1, alone: 0, works: 0, kept: 0 })

  const offHost = await bench(t).start({ mainWorkGate: 'off' })
  offHost.rt.monotonicNow = () => 0
  offHost.emit('a', 'turn/start', { turn: 1 })
  toolCall(offHost, 'a', 0)
  offHost.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(offHost.rt.state.mainTurns, undefined)
})

test('another Bot is not time-gated, repeat-gated or audited', async (t) => {
  const host = await bench(t).start({ mainTurnSoftSeconds: 1, mainTurnHardSeconds: 2, mainWorkSameTarget: 2 })
  let clock = 0
  host.rt.monotonicNow = () => clock
  host.emit('b', 'turn/start', { turn: 1 })
  clock = 60 * 60_000
  assert.equal(host.rt.sweepWorkGate(), false)
  for (let at = 0; at < 6; at += 1) toolCall(host, 'b', at, 'bash', { command: 'ssh gpu1 uptime' })
  await settle()
  assert.deepEqual(cancelledAt(host, 'b'), [])
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(host.rt.state.mainTurns?.length ?? 0, 0)
  assert.deepEqual(host.rt.workAudit(), { turns: 0, alone: 0, works: 0, kept: 0 })
})

test('a group round the Main Bot talks in is gated the same way', async (t) => {
  const host = await bench(t).start()
  host.rt.monotonicNow = () => 0
  host.rt.groupOwners.set('ga', { roomId: 'r1', botId: 'a' })
  host.emit('ga', 'turn/start', { turn: 1 })
  host.rt.monotonicNow = () => 130_000
  assert.equal(host.rt.sweepWorkGate(), true)
  await settle()
  assert.deepEqual(host.agents.get('ga')?.cancelled ?? [], [{ kind: 'hook', reason: WORK_GATE }])
  host.rt.groupOwners.delete('ga')
})

test('the audit reaches the state payload and the panel line', async (t) => {
  const host = await bench(t).start()
  host.rt.monotonicNow = () => 0
  host.emit('a', 'turn/start', { turn: 1 })
  for (let at = 0; at < 3; at += 1) toolCall(host, 'a', at, 'write', { file_path: '/tmp/a' })
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const entry = host.rt.state.mainTurns.at(-1)
  assert.deepEqual([entry.tools, entry.bash, entry.writes, entry.works], [3, 0, 3, 0])
  const answer = await host.call('state', {})
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.value.workAudit, { turns: 1, alone: 1, works: 0, kept: 0 })
})

test('keep_working refuses a Bot that is not the Main Bot, and a reason is required', async (t) => {
  const host = await bench(t).start()
  host.emit('b', 'turn/start', { turn: 1 })
  assert.match(await host.tool('keep_working', { reason: 'because' }, 'b'), /for the Main Bot/)
  host.emit('a', 'turn/start', { turn: 1 })
  assert.match(await host.tool('keep_working', { reason: '   ' }, 'a'), /Give one sentence/)
})
