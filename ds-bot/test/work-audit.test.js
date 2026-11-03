// The Main Bot's own work: each of its turns is audited, and a turn that keeps working
// without handing anything on is stopped — unless it says why the work must be its own.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { MAIN_GATE_TOOLS, mainGateOf } from '../src/host/work-state.js'
import { WORK_GATE } from '../src/host/work-audit.js'

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

function toolCall(host, sessionId, at, name = 'bash') {
  host.emit(sessionId, 'tool/call', { callId: `c${at}`, name, arguments: '{}' })
  host.emit(sessionId, 'tool/result', { callId: `c${at}` })
}

async function ownTurn(host, sessionId, count, name = 'bash', turn = 1) {
  host.emit(sessionId, 'turn/start', { turn })
  for (let at = 0; at < count; at += 1) toolCall(host, sessionId, at, name)
  await settle()
}

const agentAt = (host, id) => host.agents.get(host.rt.chatOf(id))
const cancelledAt = (host, id) => agentAt(host, id)?.cancelled ?? []

test('the gate policy defaults to enforce at ten tool calls, and is configurable', () => {
  assert.equal(MAIN_GATE_TOOLS, 10)
  assert.deepEqual(mainGateOf(), { mode: 'enforce', tools: 10 })
  assert.deepEqual(mainGateOf({ mainWorkGate: 'audit', mainWorkGateTools: 4 }), { mode: 'audit', tools: 4 })
  assert.deepEqual(mainGateOf({ mainWorkGate: 'sometimes', mainWorkGateTools: -1 }), { mode: 'enforce', tools: 10 })
})

test('a Main Bot turn that works alone past the threshold is stopped and told why', async (t) => {
  const host = await bench(t).start()
  await ownTurn(host, 'a', 10)
  const agent = agentAt(host, 'a')
  assert.deepEqual(agent.cancelled, [{ kind: 'hook', reason: WORK_GATE }])
  const notice = agent.calls.at(-1)
  assert.equal(notice[0], 'followup')
  assert.match(textOf(notice[1]), /^\[DS Bot stopped this turn\]/)
  assert.match(textOf(notice[1]), /made 10 tool calls without handing on any work/)
  assert.match(textOf(notice[1]), /keep_working/)
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
  // One line in the audit: it worked alone.
  assert.deepEqual(host.rt.workAudit(), { turns: 1, alone: 1, works: 0, kept: 0 })
  // Only the tenth call stopped it, not the ninth.
  const other = await bench(t).start()
  await ownTurn(other, 'a', 9)
  assert.deepEqual(cancelledAt(other, 'a'), [])
})

test('a turn that handed work on is never stopped, however much it does afterwards', async (t) => {
  const host = await bench(t).start()
  host.emit('a', 'turn/start', { turn: 1 })
  assert.match(await host.tool('message_bot', { to: 'Writer', message: 'do it' }, 'a'), /Delivered to Writer/)
  for (let at = 0; at < 14; at += 1) toolCall(host, 'a', at)
  await settle()
  assert.deepEqual(cancelledAt(host, 'a'), [])
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(host.rt.workAudit(), { turns: 1, alone: 0, works: 1, kept: 0 })
})

test('keep_working excuses the turn and keeps the reason with it', async (t) => {
  const host = await bench(t).start()
  host.emit('a', 'turn/start', { turn: 1 })
  for (let at = 0; at < 5; at += 1) toolCall(host, 'a', at)
  assert.match(await host.tool('keep_working', { reason: '用户明确要求我直接查这台机器' }, 'a'), /Recorded: "用户明确要求我直接查这台机器"/)
  for (let at = 5; at < 16; at += 1) toolCall(host, 'a', at)
  await settle()
  assert.deepEqual(cancelledAt(host, 'a'), [])
  host.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(host.rt.workAudit(), { turns: 1, alone: 1, works: 0, kept: 1 })
  assert.equal(host.rt.state.mainTurns.at(-1).kept, '用户明确要求我直接查这台机器')
})

test('another Bot doing its own work is not gated and not audited', async (t) => {
  const host = await bench(t).start()
  await ownTurn(host, 'b', 14)
  assert.deepEqual(cancelledAt(host, 'b'), [])
  assert.equal(host.rt.state.mainTurns?.length ?? 0, 0)
  assert.deepEqual(host.rt.workAudit(), { turns: 0, alone: 0, works: 0, kept: 0 })
})

test('a group round the Main Bot talks in is gated the same way', async (t) => {
  const host = await bench(t).start()
  host.rt.groupOwners.set('ga', { roomId: 'r1', botId: 'a' })
  await ownTurn(host, 'ga', 12)
  assert.deepEqual(host.agents.get('ga')?.cancelled ?? [], [{ kind: 'hook', reason: WORK_GATE }])
  host.rt.groupOwners.delete('ga')
})

test('the threshold is configurable, and audit mode records without stopping', async (t) => {
  const short = await bench(t).start({ mainWorkGateTools: 3 })
  await ownTurn(short, 'a', 3)
  assert.deepEqual(cancelledAt(short, 'a'), [{ kind: 'hook', reason: WORK_GATE }])

  const auditOnly = await bench(t).start({ mainWorkGate: 'audit' })
  await ownTurn(auditOnly, 'a', 15)
  assert.deepEqual(cancelledAt(auditOnly, 'a'), [])
  auditOnly.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.deepEqual(auditOnly.rt.workAudit(), { turns: 1, alone: 1, works: 0, kept: 0 })

  const off = await bench(t).start({ mainWorkGate: 'off' })
  await ownTurn(off, 'a', 15)
  assert.deepEqual(cancelledAt(off, 'a'), [])
  off.emit('a', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(off.rt.state.mainTurns, undefined)
})

test('the audit reaches the state payload and the panel line', async (t) => {
  const host = await bench(t).start()
  host.emit('a', 'turn/start', { turn: 1 })
  for (let at = 0; at < 3; at += 1) toolCall(host, 'a', at, 'write')
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
