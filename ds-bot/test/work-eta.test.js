// The estimate a hand-off carries: the team compares it with the clock only, tells the
// Bot that handed the work on at 80% and at 150%, and expects it to act — up the
// escalation ladder (a higher thinking level, then a stronger model), never to pass the
// decision to the user. A temporary raise goes back when the work ends.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { ETA_LATE_RATIO, ETA_SOFT_RATIO, etaDeviation, etaView, parseEta } from '../src/host/work-state.js'

const MODELS = ['deepseek-flash', 'deepseek-pro']
const REASONING = {
  'deepseek/deepseek-flash': { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }], defaultEffort: 'low' } },
  'deepseek/deepseek-pro': { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
}

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', model: 'deepseek/deepseek-flash', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', model: 'deepseek/deepseek-flash', createdAt: 2 },
    c: { id: 'c', name: 'Researcher', role: 'Look', sessionId: 'c', model: 'deepseek/deepseek-pro', createdAt: 3 },
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
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => MODELS.map(id => ({ id })),
      resolveModelInfo: async (provider, model) => REASONING[`${provider}/${model}`] ?? {},
    },
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

const settle = () => new Promise(resolve => setTimeout(resolve, 60))
const textOf = message => message.content.map(block => block.text ?? '').join('')
const callsOf = (agents, sessionId) => agents.get(sessionId)?.calls ?? []

function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-work-eta-'))
  const hosts = []
  t.after(async () => {
    for (const host of hosts.reverse()) await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { home, start: async (config) => { const host = await startHost(home, config); hosts.push(host); return host } }
}

// A work as it looks after `minutes` of estimate: `at` is when it was opened.
const opened = (minutes, at) => ({ at, eta: { minutes, text: `${minutes} min`, at } })

test('an estimate reads numbers, phrases and spelled-out numerals', () => {
  assert.deepEqual(parseEta(20), { text: '20 min', minutes: 20 })
  assert.deepEqual(parseEta('20 分钟'), { text: '20 分钟', minutes: 20 })
  assert.equal(parseEta('1.5h').minutes, 90)
  assert.equal(parseEta('2 hours').minutes, 120)
  assert.deepEqual(parseEta('半小时'), { text: '半小时', minutes: 30, approximate: true })
  assert.deepEqual(parseEta('几小时'), { text: '几小时', minutes: 180, approximate: true })
  assert.equal(parseEta('45 seconds').minutes, 0.75)
  assert.equal(parseEta('soon'), undefined)
  assert.equal(parseEta(''), undefined)
  assert.equal(parseEta(-5), undefined)
})

test('the deviation is time only: 80% then 150%, twice at most', () => {
  const at = 1_000
  const work = { ...opened(10, at), from: 'a', to: 'b' }
  assert.equal(etaDeviation(work, at + 7 * 60_000), undefined, 'before 80% nothing is owed')
  assert.deepEqual(etaDeviation(work, at + 8 * 60_000).stage, 1)
  assert.equal(ETA_SOFT_RATIO, 0.8)
  assert.equal(ETA_LATE_RATIO, 1.5)
  // Already reminded at this stage: nothing new.
  assert.equal(etaDeviation({ ...work, eta: { ...work.eta, reminded: [1] } }, at + 12 * 60_000), undefined)
  assert.equal(etaDeviation({ ...work, eta: { ...work.eta, reminded: [1, 2] } }, at + 60 * 60_000), undefined)
  // A work that reported how it ended is not late any more.
  assert.equal(etaDeviation({ ...work, report: { state: 'ready', at: at + 9 * 60_000 } }, at + 30 * 60_000), undefined)
  // No estimate, no comparison.
  assert.equal(etaDeviation({ at, from: 'a', to: 'b' }, at + 60 * 60_000), undefined)
})

test('the panel view says what was expected, how long it ran and how that compares', () => {
  const work = opened(10, 1_000)
  const view = etaView(work, 1_000 + 9 * 60_000)
  assert.equal(view.minutes, 10)
  assert.equal(view.pace, 'due')
  assert.equal(etaView(work, 1_000 + 16 * 60_000).pace, 'late')
  assert.equal(etaView(work, 1_000 + 60_000).pace, 'on')
  const none = etaView({ at: 1_000 }, 1_000 + 60_000)
  assert.equal(none.pace, 'unknown')
  assert.equal(none.minutes, undefined)
})

test('message_bot keeps the estimate on the work, and a missing one is not a failure', async (t) => {
  const { rt, tool } = await bench(t).start()
  await tool('message_bot', { to: 'Writer', message: 'Draft the report.', eta: '20 minutes' }, 'a')
  const withEta = Object.values(rt.state.works ?? {}).find(work => work.to === 'b')
  assert.equal(withEta.eta.minutes, 20)
  assert.equal(withEta.eta.text, '20 minutes')
  await tool('message_bot', { to: 'Researcher', message: 'Check the sources.' }, 'a')
  const without = Object.values(rt.state.works ?? {}).find(work => work.to === 'c')
  assert.equal(without.eta, undefined)
  const rows = rt.runningWorks()
  assert.equal(rows.length, 2)
  assert.equal(rows.find(row => row.bot === 'Writer').minutes, 20)
  assert.equal(rows.find(row => row.bot === 'Researcher').pace, 'unknown')
})

test('at 80% the Bot that handed the work on is told, once, with the next rung', async (t) => {
  const { home, start } = bench(t)
  const { rt, agents } = await start()
  rt.openWork('w1', { from: 'a', to: 'b', eta: '10 minutes' })
  const at = Date.now() + 8 * 60_000
  assert.equal(rt.sweepStalled(at), true)
  await settle()
  const calls = callsOf(agents, rt.chatOf('a'))
  assert.equal(calls.length, 1)
  const message = calls[0][1]
  assert.equal(message.source.role, 'eta')
  assert.match(textOf(message), /^\[A work you handed on to Writer is behind its estimate\]/)
  assert.match(textOf(message), /estimated at 10 min/)
  assert.match(textOf(message), /update_bot bot "Writer" effort "medium" temporary true/)
  assert.match(textOf(message), /Act now/)
  // Not the user's problem: no inbox row and no question card.
  assert.equal(rt.needsYou().length, 0)
  assert.equal(Object.keys(rt.state.questions ?? {}).length, 0)
  // The mark is on the work, so the same stage is not reminded twice.
  assert.deepEqual(rt.state.works.w1.eta.reminded, [1])
  assert.equal(rt.sweepStalled(at + 60_000), false)
  await settle()
  assert.equal(callsOf(agents, rt.chatOf('a')).length, 1)
  const due = rt.etaAudit().find(entry => entry.kind === 'due')
  assert.equal(due.work, 'w1')
  assert.equal(due.minutes, 10)
  assert.ok(existsSync(join(home, 'state.json')))
})

test('at 150% it is told again, and after two notices it stops', async (t) => {
  const { rt, agents } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b', eta: '10 minutes' })
  const at = Date.now()
  rt.sweepStalled(at + 8 * 60_000)
  await settle()
  rt.sweepStalled(at + 16 * 60_000)
  await settle()
  const calls = callsOf(agents, rt.chatOf('a'))
  assert.equal(calls.length, 2)
  assert.equal(calls[1][1].source.role, 'eta-late')
  assert.match(textOf(calls[1][1]), /^\[A work you handed on to Writer is far past its estimate\]/)
  assert.match(textOf(calls[1][1]), /50% past its estimate/)
  assert.deepEqual(rt.state.works.w1.eta.reminded, [1, 2])
  // Nothing more, however often the sweep runs.
  rt.sweepStalled(at + 20 * 60_000)
  await settle()
  assert.equal(callsOf(agents, rt.chatOf('a')).length, 2)
  assert.equal(rt.etaAudit().filter(entry => entry.kind === 'late').length, 1)
})

test('a work that reported how it ended is not reminded', async (t) => {
  const { rt, agents } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b', eta: '10 minutes' })
  rt.reportWork('w1', { state: 'ready', summary: 'done' })
  assert.equal(rt.sweepStalled(Date.now() + 20 * 60_000), false)
  await settle()
  assert.equal(callsOf(agents, rt.chatOf('a')).length, 0)
})

test('a Bot that is not a Main Bot is watched the same way', async (t) => {
  const { rt, agents } = await bench(t).start()
  rt.openWork('w1', { from: 'b', to: 'c', eta: '10 minutes' })
  rt.sweepStalled(Date.now() + 9 * 60_000)
  await settle()
  const calls = callsOf(agents, rt.chatOf('b'))
  assert.equal(calls.length, 1)
  assert.match(textOf(calls[0][1]), /update_bot bot "Researcher"/)
  assert.equal(rt.needsYou().length, 0)
})

test('a temporary raise takes effect, is written into the audit, and is put back', async (t) => {
  const { rt, tool } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b', eta: '10 minutes' })
  rt.sweepStalled(Date.now() + 9 * 60_000)
  await settle()
  assert.equal(rt.etaTargetOf(rt.chatOf('a'), 'b'), 'w1')
  const out = await tool('update_bot', { bot: 'Writer', effort: 'medium', temporary: true }, 'a')
  assert.match(out, /temporary/i)
  assert.equal(rt.state.bots.b.effort, 'medium')
  const raised = rt.etaAudit().find(entry => entry.kind === 'effort')
  assert.equal(raised.work, 'w1')
  assert.equal(raised.bot, 'Writer')
  assert.equal(raised.to.effort, 'medium')
  assert.equal(raised.temporary, true)
  assert.equal(raised.from.effort, undefined)
  // The work ending puts the Bot back the way it was.
  rt.closeWork('w1', 'Writer', 'done')
  await settle()
  assert.equal(rt.state.bots.b.effort, undefined)
  const restored = rt.etaAudit().find(entry => entry.kind === 'restore')
  assert.equal(restored.bot, 'Writer')
  assert.equal(rt.runningWorks().length, 0)
})

test('a level the model does not serve is refused and the levels are named', async (t) => {
  const { rt, tool } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b', eta: '10 minutes' })
  rt.sweepStalled(Date.now() + 9 * 60_000)
  await settle()
  const out = await tool('update_bot', { bot: 'Writer', effort: 'maximum', temporary: true }, 'a')
  assert.match(out, /Thinking level maximum is not available for deepseek\/deepseek-flash/)
  assert.match(out, /Available: Low, Medium/)
  assert.equal(rt.state.bots.b.effort, undefined)
  assert.equal(rt.etaAudit().some(entry => entry.kind === 'effort'), false)
})

test('temporary needs a work that is behind its estimate', async (t) => {
  const { rt, tool } = await bench(t).start()
  const out = await tool('update_bot', { bot: 'Writer', effort: 'high', temporary: true }, 'a')
  assert.match(out, /nothing .* is behind its estimate/i)
  assert.equal(rt.state.bots.b.effort, undefined)
})

test('the ladder moves to a stronger model when the level is already the top', async (t) => {
  const { rt } = await bench(t).start()
  rt.state.bots.b.effort = 'medium'
  rt.openWork('w1', { from: 'a', to: 'b', eta: '10 minutes' })
  const advice = await rt.etaAdvice('w1')
  assert.equal(advice.kind, 'model')
  assert.equal(advice.to, 'deepseek/deepseek-pro')
  assert.ok(advice.options.includes('deepseek/deepseek-pro'))
})

test('moving the work to another Bot of the same kind is marked as the non-default step', async (t) => {
  const { rt, tool } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b', eta: '10 minutes' })
  rt.sweepStalled(Date.now() + 9 * 60_000)
  await settle()
  await tool('message_bot', { to: 'Researcher', message: 'Take over the draft.' }, 'a')
  const hand = rt.etaAudit().find(entry => entry.kind === 'hand')
  assert.equal(hand.work, 'w1')
  assert.equal(hand.target, 'Researcher')
  assert.equal(hand.nonDefault, true)
  assert.equal(hand.ladder, 'horizontal')
})

test('a raise made without temporary is recorded as permanent and is not put back', async (t) => {
  const { rt, tool } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b', eta: '10 minutes' })
  rt.sweepStalled(Date.now() + 9 * 60_000)
  await settle()
  const out = await tool('update_bot', { bot: 'Writer', effort: 'medium' }, 'a')
  assert.match(out, /stays/)
  const raised = rt.etaAudit().find(entry => entry.kind === 'effort')
  assert.equal(raised.temporary, false)
  rt.closeWork('w1', 'Writer', 'done')
  await settle()
  assert.equal(rt.state.bots.b.effort, 'medium', 'a permanent raise is not undone')
  assert.equal(rt.etaAudit().some(entry => entry.kind === 'restore'), false)
})

test('stopping the Bot and handing the work on read as one action in the audit', async (t) => {
  const { rt, tool } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b', eta: '10 minutes' })
  rt.sweepStalled(Date.now() + 9 * 60_000)
  await settle()
  // Writer has a turn running, so it can be stopped.
  rt.live.set('b', { turn: { info: undefined }, since: Date.now() })
  const stopped = await tool('stop_bot', { bot: 'Writer', reason: 'Behind its estimate; take a break.' }, 'a')
  assert.match(stopped, /Stopped Writer/)
  rt.live.delete('b')
  // The same turn hands the work to someone else.
  await tool('message_bot', { to: 'Researcher', message: 'Take this over from Writer.' }, 'a')
  const audit = rt.etaAudit()
  const stop = audit.find(entry => entry.kind === 'stop')
  assert.equal(stop.target, 'Writer')
  assert.match(stop.reason, /Behind its estimate/)
  const hand = audit.find(entry => entry.kind === 'hand')
  assert.equal(hand.work, 'w1')
  assert.equal(hand.target, 'Researcher')
  assert.equal(hand.followUp, true)
  assert.equal(hand.after, 'stop')
  assert.equal(hand.nonDefault, true)
})
