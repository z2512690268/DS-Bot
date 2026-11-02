// What a piece of handed-on work waits for, and the report a Bot makes about it.
//
// The state is derived from the work itself, so an idle work cannot be called finished;
// a report adds the Bot's own judgement above the answer that goes up the tree, and
// progress stays out of it.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { DEFAULT_REPORT, STALL_MS, normalizeReport, reportLine, stalledReport, workStateOf } from '../src/host/work-state.js'

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
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await tool('list_bots', {}, 'a')
  return { rt, tool, call, agents, home, state: rt.state, stop: () => ctx.dispose() }
}

function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-work-report-'))
  const hosts = []
  t.after(async () => {
    for (const host of hosts.reverse()) await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { start: async () => { const host = await startHost(home); hosts.push(host); return host } }
}

test('a work that ends without a report is understood as ready', () => {
  assert.equal(DEFAULT_REPORT, 'ready')
  assert.deepEqual(workStateOf({ at: 1, open: [], results: [] }), { state: 'working', since: 1 })
})

test('a question for the user outranks anything the work holds', () => {
  const state = workStateOf({ at: 1, attention: { question: 'Which file?', at: 5 } })
  assert.equal(state.state, 'person/answer')
  assert.equal(state.question, 'Which file?')
  assert.equal(state.since, 5)
})

test('a blocked or failed report is a state only the user can end', () => {
  const blocked = workStateOf({ at: 1, report: { state: 'blocked', summary: 'needs the key', at: 9 } })
  assert.equal(blocked.state, 'person/blocked')
  assert.equal(blocked.humanAction, undefined)
  assert.equal(workStateOf({ at: 1, report: { state: 'failed', at: 9 } }).state, 'person/failed')
  assert.equal(workStateOf({ at: 1, report: { state: 'ready', at: 9 } }).state, 'person/review')
  assert.equal(workStateOf({ at: 1, report: { state: 'dropped', at: 9 } }).state, 'working')
})

test('a report is stored without trailing space, and an unknown state is refused', () => {
  assert.deepEqual(normalizeReport({ state: 'blocked', summary: '  no access  ', human_action: ' Give it  ' }, 7),
    { report: { state: 'blocked', summary: 'no access', humanAction: 'Give it', at: 7 } })
  assert.ok(normalizeReport({ state: 'done' }).error)
})

test('the report line is empty without a report, and names the outcome with one', () => {
  assert.equal(reportLine(undefined), '')
  assert.equal(reportLine({ state: 'blocked', summary: 'no access' }), '[reported blocked: no access]')
  assert.equal(reportLine({ state: 'failed', humanAction: 'Restart it' }), '[reported failed]\nRestart it')
})

test('a report goes up with the answer, and progress stays out of it', async (t) => {
  const { rt } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  assert.deepEqual(rt.reportWork('w1', { state: 'progress', summary: 'reading the file' }).report.state, 'progress')
  assert.equal(rt.answerText('w1', 'Still reading.', 'Writer'), 'Still reading.')
  rt.reportWork('w1', { state: 'blocked', summary: 'the file needs a key', human_action: 'Add the key' })
  assert.equal(rt.answerText('w1', 'I cannot read the file.', 'Writer'),
    '[reported blocked: the file needs a key]\nAdd the key\n\nI cannot read the file.')
  assert.equal(rt.workState('w1').state, 'person/blocked')
})

test('a report about no work is refused, and so is a state that is not one', async (t) => {
  const { rt, tool } = await bench(t).start()
  assert.match(await tool('report', { state: 'ready' }, 'b'), /Nothing to report/)
  rt.openWork('w1', { from: 'a', to: 'b' })
  assert.match(rt.reportWork('w1', { state: 'done' }).error, /one of/)
  assert.match(rt.reportWork('nope', { state: 'ready' }).error, /no work to report/)
})

test('a report that needs the user puts the question where the work was asked for', async (t) => {
  const { rt, state } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  rt.reportWork('w1', {
    state: 'blocked', summary: 'needs a key', human_action: '用哪一把钥匙？',
    human_options: ['主钥匙', '备用钥匙'],
  })
  rt.closeWork('w1', 'Writer', 'I cannot read the file.')
  const card = state.questions[rt.chatOf('a')]
  assert.equal(card.question, '用哪一把钥匙？')
  assert.equal(card.detail, 'Writer: needs a key')
  assert.deepEqual(card.options, [{ label: '主钥匙' }, { label: '备用钥匙' }])
  assert.equal(card.allowCustom, true)
  assert.equal(card.attention.ownerId, 'b')
  assert.equal(card.attention.askerId, 'a')
  assert.ok(typeof card.attention.work === 'string' && card.attention.work !== '')
})

test('the answer to one of those cards goes straight to the Bot that could not go on', async (t) => {
  const { rt, state, call, agents } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  rt.reportWork('w1', { state: 'blocked', summary: 'needs a key', human_action: '用哪一把钥匙？', human_options: ['主钥匙', '备用钥匙'] })
  rt.closeWork('w1', 'Writer', 'I cannot read the file.')
  const chat = rt.chatOf('a')
  const card = state.questions[chat]
  const answer = await call('answer-question', { sessionId: chat, questionId: card.id, answer: { selected: ['备用钥匙'] } })
  assert.equal(answer.ok, true)
  assert.equal(state.questions[chat], undefined)
  // A new request from the Bot that asked to the Bot that could not go on, so the
  // answer arrives as work instead of as a reply with nobody waiting for it.
  const opened = Object.entries(state.works).filter(([, work]) => work.from === 'a' && work.to === 'b')
  assert.equal(opened.length, 1)
  // The work goes on rather than starting over: the answer reopens the work the
  // report was made for, so the Bot that asked still waits for the same one.
  assert.equal(opened[0][0], card.attention.work)
  const woken = agents.get(rt.chatOf('b')).calls
  assert.equal(woken.length, 1)
  assert.match(JSON.stringify(woken[0][1]), /备用钥匙/)
  assert.match(JSON.stringify(woken[0][1]), /Go on with the work/)
})

test('a report with nothing for the user opens no question card', async (t) => {
  const { rt, state } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  rt.reportWork('w1', { state: 'ready', summary: 'the page is fixed' })
  rt.closeWork('w1', 'Writer', 'Done.')
  assert.equal(state.questions[rt.chatOf('a')], undefined)
})

test('work that stopped reporting is marked stalled, and a fresh one is not', () => {
  const at = Date.now()
  assert.deepEqual(stalledReport({ at: at - STALL_MS - 60_000 }, at),
    { state: 'blocked', summary: 'no progress for 31 min', at, stalled: true, reason: 'no_progress' })
  assert.equal(stalledReport({ at }, at), undefined)
  assert.equal(stalledReport({ at: at - STALL_MS - 60_000, report: { state: 'ready', at } }, at), undefined)
  assert.equal(stalledReport({ at: 0, progress: { state: 'progress', at: at - 1000 } }, at), undefined)
})

test('sweeping marks the stale work, and the Bot that asked reads why it waits', async (t) => {
  const { rt } = await bench(t).start()
  rt.openWork('old', { from: 'a', to: 'b' })
  const started = Date.now()
  assert.equal(rt.sweepStalled(started), false)
  assert.equal(rt.sweepStalled(started + STALL_MS + 60_000), true)
  assert.equal(rt.workState('old').state, 'person/blocked')
  assert.match(rt.workState('old').summary, /no progress for \d+ min/)
  assert.match(rt.answerText('old', 'nothing yet', 'Writer'), /^\[reported blocked: no progress for \d+ min\]/)
  rt.openWork('fresh', { from: 'a', to: 'b' })
  assert.equal(rt.sweepStalled(Date.now()), false)
  assert.equal(rt.workState('fresh').state, 'working')
})

test('needsYou is the one list of what waits for the user', async (t) => {
  const { rt, state } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  rt.reportWork('w1', { state: 'blocked', summary: 'no access', human_action: '可以先打开文件吗？' })
  state.questions[rt.chatOf('b')] = { id: 'q1', question: '选哪个方向？', options: [{ label: '左' }], allowCustom: true, askedAt: 5 }
  const items = rt.needsYou()
  assert.deepEqual(items.map(item => item.kind).sort(), ['answer', 'blocked'])
  const blocked = items.find(item => item.kind === 'blocked')
  assert.equal(blocked.work, 'w1')
  // The row opens the Bot that is blocked, not the one that asked for the work.
  assert.equal(blocked.bot, 'Writer')
  assert.equal(blocked.askedBy, 'Chief')
  assert.equal(blocked.summary, 'no access')
  const asked = items.find(item => item.kind === 'answer')
  assert.equal(asked.question, '选哪个方向？')
  assert.equal(asked.bot, 'Writer')
})
