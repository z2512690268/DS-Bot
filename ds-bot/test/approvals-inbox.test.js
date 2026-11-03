// Approvals in a Bot's own chat, in two levels: the fixed policy decides the routine ones
// by itself, and only what it cannot place waits in the "Needs you" list. An approval
// that waits too long is reported to the Bot that handed the work on, once.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const seed = () => ({
  version: 1,
  workspaceId: 'w1',
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

async function startHost({ dshHome, workspace, home }, config = {}) {
  // The policy compares the real roots of this test, never the user's own DSH data.
  process.env.DSH_HOME = dshHome
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
      get: id => (id === 'w1' ? { id, path: workspace } : undefined),
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
      prompt: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home, ...config })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  await rt.teamTools.find(definition => definition.name === 'list_bots').execute({}, { agent: { id: 'a' } })
  return { rt, ctx, agents, call, dshHome, stop: async () => { await ctx.dispose() } }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 30))
const textOf = message => message.content.map(block => block.text ?? '').join('')

// One approval request, as DSH hands it to the listeners: the argument `next` is DSH's
// own card, which stays pending unless the test resolves it.
function ask(ctx, { sessionId = 'b', tool = 'bash', reason = '', callId, next = () => new Promise(() => {}) } = {}) {
  const listener = (ctx.listeners.get('approval/request') ?? [])[0]
  assert.ok(listener, 'the approval listener is registered')
  return listener({ agent: { session: { id: sessionId } }, toolName: tool, reason, ...(callId === undefined ? {} : { callId }) }, next)
}

function bench(t) {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-approvals-'))
  const paths = { dshHome: join(root, 'dsh'), workspace: join(root, 'team'), home: join(root, 'bot') }
  mkdirSync(paths.home, { recursive: true })
  const hosts = []
  t.after(async () => {
    for (const host of hosts.reverse()) await host.stop()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })
  return { ...paths, start: async (config) => { const host = await startHost(paths, config); hosts.push(host); return host } }
}


test('a copy-profile approval is allowed by the policy and never reaches the user', async (t) => {
  const { rt, ctx } = await bench(t).start()
  const outcome = await ask(ctx, {
    reason: 'escalate sandbox to danger-full-access: 在副本 profile 里装依赖/更新 lock',
  })
  assert.equal(outcome, 'allowed-once')
  assert.deepEqual(rt.needsYou(), [])
  const audit = rt.state.approvalLog.at(-1)
  assert.equal(audit.decidedBy, 'policy')
  assert.equal(audit.outcome, 'allowed-once')
  assert.equal(audit.rule, 'copy-profile')
  assert.match(audit.ruleWhy, /copy of the profile/)
})

test('writing the user\'s DSH data is rejected by the policy, and the Bot hears why', async (t) => {
  const { rt, ctx, agents, dshHome } = await bench(t).start()
  rt.live.set('b', { turn: 1, info: { role: 'request', exchangeId: 'w1' }, calls: new Map([['c1', { name: 'write', args: JSON.stringify({ file_path: join(dshHome, 'profiles', 'desktop', 'profile.json') }) }]]) })
  const outcome = await ask(ctx, { tool: 'write', callId: 'c1', reason: 'save the copied profile' })
  assert.equal(outcome, 'rejected')
  assert.deepEqual(rt.needsYou(), [])
  await settle()
  const calls = agents.get('b').calls
  assert.equal(calls.length, 1)
  assert.match(textOf(calls[0][1]), /^\[Your approval request was rejected\]/)
  assert.match(textOf(calls[0][1]), /stays denied, so do not retry/)
  assert.match(textOf(calls[0][1]), /writes the user's own DSH data/)
  const audit = rt.state.approvalLog.at(-1)
  assert.equal(audit.decidedBy, 'policy')
  assert.equal(audit.rule, 'user-dsh-data')
  assert.equal(audit.choice, 'reject')
})

test('a rule that cannot decide waits in the inbox, and a Main Bot answers it', async (t) => {
  const { rt, ctx, call } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  rt.live.set('b', {
    turn: 1,
    info: { role: 'request', exchangeId: 'w1' },
    calls: new Map([['c1', { name: 'bash', args: JSON.stringify({ description: 'do the thing', command: 'some-unknown-command --flag' }) }]]),
  })
  const pending = ask(ctx, { callId: 'c1', reason: 'escalate sandbox to danger-full-access: do the thing' })
  const item = rt.needsYou().find(entry => entry.kind === 'approval')
  assert.ok(item, 'the undecided approval is in the inbox')
  assert.equal(item.bot, 'Writer')
  assert.equal(item.summary, 'bash: escalate sandbox to danger-full-access: do the thing')
  assert.match(item.unsure, /no rule covers/)
  assert.match(item.approvals[0].unsure, /no rule covers/)
  assert.equal(item.approvals[0].detail, 'some-unknown-command --flag', 'the object being escalated is in the card')
  assert.equal(item.approvals[0].description, 'do the thing')
  assert.equal(item.key, 'approval:b')
  // The main chat answers through the same endpoint as every other card.
  assert.equal((await call('approval-answer', { id: item.approvals[0].id, choice: 'allow', by: 'a' })).ok, true)
  assert.equal(await pending, 'allowed-once')
  assert.deepEqual(rt.needsYou(), [])
  const audit = rt.state.approvalLog.at(-1)
  assert.equal(audit.decidedBy, 'main-bot')
  assert.equal(audit.by, 'a')
  assert.equal(audit.byName, 'Chief')
  assert.equal(audit.onBehalfOfUser, true)
  assert.match(audit.note, /on the user's behalf/)
  assert.equal(audit.rule, 'unmatched')
  const view = (await call('state', {})).value
  assert.equal(view.approvalAudit.at(-1).byName, 'Chief')
  // A refusal from the main chat reaches the waiting Bot too.
  const second = ask(ctx, { reason: 'escalate sandbox to danger-full-access: another thing' })
  const row = rt.needsYou().find(entry => entry.kind === 'approval')
  assert.equal((await call('approval-answer', { id: row.approvals[0].id, choice: 'reject', by: 'a' })).ok, true)
  assert.equal(await second, 'rejected')
})

test('an approval that waits too long is reported blocked to the asking Bot, once', async (t) => {
  const { rt, ctx, agents } = await bench(t).start({ approvalTimeoutMinutes: 3 })
  rt.openWork('w1', { from: 'a', to: 'b' })
  rt.live.set('b', { turn: 1, info: { role: 'request', exchangeId: 'w1' } })
  void ask(ctx, { reason: 'escalate sandbox to danger-full-access: do the thing' })
  const at = rt.approvalsView()[0].at
  assert.equal(await rt.sweepApprovals(at + 2 * 60_000), false, 'nothing before the timeout')
  assert.equal(agents.get('a')?.calls.length ?? 0, 0)
  assert.equal(await rt.sweepApprovals(at + 4 * 60_000), true)
  const calls = agents.get('a').calls
  assert.equal(calls.length, 1, 'the asking Bot is told once')
  assert.equal(calls[0][1].source.role, 'approval')
  assert.match(textOf(calls[0][1]), /^\[Writer is blocked on an approval\]/)
  assert.match(textOf(calls[0][1]), /blocked waiting for the user's approval to run bash/)
  assert.match(textOf(calls[0][1]), /has waited \d+ min/)
  assert.match(textOf(calls[0][1]), /no rule covers this request/)
  assert.equal(await rt.sweepApprovals(at + 6 * 60_000), false, 'a second sweep stays quiet')
  assert.equal(agents.get('a').calls.length, 1)
})

test('several approvals in one chat are one row that opens into each', async (t) => {
  const { rt, ctx, call } = await bench(t).start()
  void ask(ctx, { reason: 'escalate sandbox to danger-full-access: first unknown' })
  void ask(ctx, { reason: 'escalate sandbox to danger-full-access: second unknown' })
  const items = rt.needsYou().filter(entry => entry.kind === 'approval')
  assert.equal(items.length, 1)
  assert.equal(items[0].approvals.length, 2)
  assert.equal(items[0].more, 1)
  assert.match(items[0].summary, /first unknown/)
  assert.equal((await call('approval-answer', { id: items[0].approvals[0].id, choice: 'allow', by: 'a' })).ok, true)
  const left = rt.needsYou().find(entry => entry.kind === 'approval')
  assert.equal(left.approvals.length, 1)
  assert.equal((await call('approval-answer', { id: left.approvals[0].id, choice: 'allow', by: 'a' })).ok, true)
  assert.deepEqual(rt.needsYou(), [])
})

test('a group approval keeps its own path and never enters the user\'s inbox', async (t) => {
  const { rt, ctx } = await bench(t).start()
  rt.groupOwners.set('g1', { botId: 'b', roomId: 'r1' })
  const pending = ask(ctx, { sessionId: 'g1', reason: 'escalate sandbox to danger-full-access: 写 ~/.dsh' })
  assert.deepEqual(rt.needsYou(), [])
  const entry = rt.approvalsView()[0]
  assert.equal(entry.roomId, 'r1')
  rt.answerApproval(entry.id, 'allow')
  assert.equal(await pending, 'allowed-once')
  const audit = rt.state.approvalLog.at(-1)
  assert.equal(audit.via, 'group')
  assert.equal(audit.decidedBy, 'user')
})
