// A chain that stopped: a Bot ends its turn with its work still open and nothing
// running. The host nudges the owner itself, once every 30 seconds and three times at
// most, then marks the work stalled and tells the Bot that asked. The counters live on
// the work, so a restart picks a waiting chain up instead of forgetting it.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { RESUME_MAX, RESUME_SECONDS, resumeOpen, resumePolicyOf } from '../src/host/work-state.js'

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Researcher', role: 'Look', sessionId: 'c', createdAt: 3 },
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
  return { rt, ctx, agents, tool, stop: async () => { await ctx.dispose() } }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 40))
const textOf = message => message.content.map(block => block.text ?? '').join('')
const callsOf = (agents, sessionId) => agents.get(sessionId)?.calls ?? []

function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-work-resume-'))
  const hosts = []
  t.after(async () => {
    for (const host of hosts.reverse()) await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { home, start: async (config) => { const host = await startHost(home, config); hosts.push(host); return host } }
}

test('the nudge policy is 30 seconds and three tries, overridable', () => {
  assert.deepEqual(resumePolicyOf(), { after: RESUME_SECONDS * 1000, max: RESUME_MAX })
  assert.equal(RESUME_SECONDS, 30)
  assert.equal(RESUME_MAX, 3)
  assert.deepEqual(resumePolicyOf({ workResumeSeconds: 10, workResumeMax: 5 }), { after: 10_000, max: 5 })
  assert.deepEqual(resumePolicyOf({ workResumeSeconds: -1, workResumeMax: 'many' }), { after: 30_000, max: 3 })
})

test('a work may be nudged only while it is open and not stopped', () => {
  const work = { from: 'a', to: 'b', at: 0, open: [] }
  assert.deepEqual(resumeOpen(work, 60_000), { attempts: 0, gaveUp: false, nextAt: undefined })
  assert.equal(resumeOpen({ ...work, halted: { at: 1 } }, 60_000), undefined, 'a stop the user asked for is not undone')
  assert.equal(resumeOpen({ ...work, open: ['c'] }, 60_000), undefined, 'waiting on sub-work is the chain going on')
  assert.equal(resumeOpen({ ...work, report: { state: 'ready', at: 10 } }, 60_000), undefined)
  assert.equal(resumeOpen({ ...work, report: { state: 'blocked', at: 10 } }, 60_000), undefined)
  assert.equal(resumeOpen({ ...work, proposal: { text: 'x' } }, 60_000), undefined)
})

test('a stopped chain is nudged once after 30 seconds, not before', async (t) => {
  const { rt, agents } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  const opened = rt.state.works.w1.at
  assert.equal(rt.sweepResume(opened + 10_000), true, 'the first pass schedules the nudge')
  assert.equal(rt.state.works.w1.resume.nextAt, opened + 30_000)
  await settle()
  assert.equal(callsOf(agents, rt.chatOf('b')).length, 0, 'nothing is sent early')
  assert.equal(rt.sweepResume(opened + 31_000), true)
  await settle()
  const calls = callsOf(agents, rt.chatOf('b'))
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1].source.role, 'work-continue')
  assert.match(textOf(calls[0][1]), /^\[Your work is still open — continue it\]/)
  assert.match(textOf(calls[0][1]), /w1/)
  assert.match(textOf(calls[0][1]), /attempt 1 of 3/)
  assert.match(textOf(calls[0][1]), /report ready/)
  assert.equal(rt.state.works.w1.resume.attempts, 1)
  // The reminder alone is not the user's problem.
  assert.equal(rt.needsYou().length, 0)
  assert.equal(Object.keys(rt.state.questions ?? {}).length, 0)
  assert.equal(rt.resumeAudit().filter(entry => entry.kind === 'continue').length, 1)
})

test('three nudges, then the work is stalled and the asker is told', async (t) => {
  const { rt, agents } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  const opened = rt.state.works.w1.at
  for (const after of [31_000, 62_000, 93_000]) {
    rt.sweepResume(opened + after)
    await settle()
  }
  const nudges = callsOf(agents, rt.chatOf('b')).filter(call => call[1].source.role === 'work-continue')
  assert.equal(nudges.length, 3)
  assert.match(textOf(nudges[2][1]), /attempt 3 of 3/)
  assert.equal(rt.sweepResume(opened + 124_000), true)
  await settle()
  assert.equal(callsOf(agents, rt.chatOf('b')).filter(call => call[1].source.role === 'work-continue').length, 3, 'no fourth nudge')
  assert.equal(rt.workState('w1').state, 'person/blocked')
  assert.equal(rt.workState('w1').reason, 'no_continue')
  assert.equal(rt.state.works.w1.resume.gaveUp, true)
  assert.equal(rt.state.works.w1.resume.attempts, 3)
  const told = callsOf(agents, rt.chatOf('a')).filter(call => call[1].source.role === 'stalled')
  assert.equal(told.length, 1, 'the Bot that handed it on reads it stalled once')
  assert.match(textOf(told[0][1]), /^\[A work you handed on to Writer stalled\]/)
  assert.match(textOf(told[0][1]), /still open after 3 continue attempts/)
  assert.equal(rt.resumeAudit().filter(entry => entry.kind === 'gave-up').length, 1)
  assert.equal(rt.state.workLog ?? undefined, undefined, 'the work stays open for its answer')
})

test('a running turn or a live job is not a stopped chain', async (t) => {
  const { rt, agents } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  const opened = rt.state.works.w1.at
  // Its turn is running.
  rt.live.set('b', { turn: { info: undefined }, since: opened })
  assert.equal(rt.sweepResume(opened + 31_000), true, 'the clock moves on instead')
  assert.equal(rt.state.works.w1.resume.attempts ?? 0, 0)
  assert.equal(rt.state.works.w1.resume.nextAt, opened + 61_000)
  rt.live.delete('b')
  // A live job it waits on.
  const job = { startedAt: opened, lastActivityAt: opened + 30_000 }
  rt.liveJobsOf = () => [job]
  rt.sweepResume(opened + 62_000)
  assert.equal(rt.state.works.w1.resume.attempts ?? 0, 0)
  rt.liveJobsOf = () => []
  await settle()
  assert.equal(callsOf(agents, rt.chatOf('b')).length, 0)
  // Free again: the nudge goes out.
  rt.sweepResume(opened + 200_000)
  await settle()
  assert.equal(rt.state.works.w1.resume.attempts, 1)
})

test('a work that reported blocked or ended is not nudged', async (t) => {
  const { rt, agents } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  rt.reportWork('w1', { state: 'blocked', summary: 'needs the user', human_action: 'Which key?' })
  rt.openWork('w2', { from: 'a', to: 'c' })
  rt.reportWork('w2', { state: 'ready', summary: 'done' })
  const opened = rt.state.works.w1.at
  assert.equal(rt.sweepResume(opened + 100_000), false)
  await settle()
  assert.equal(callsOf(agents, rt.chatOf('b')).length, 0)
  assert.equal(callsOf(agents, rt.chatOf('c')).length, 0)
})

test('a stop the user asked for is not nudged back', async (t) => {
  const { rt, agents } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  assert.equal(rt.noteWorkHalt('b', 'ds-bot/stopped'), true)
  const opened = rt.state.works.w1.at
  assert.equal(rt.sweepResume(opened + 200_000), false)
  await settle()
  assert.equal(callsOf(agents, rt.chatOf('b')).length, 0)
  // The owner speaking again lifts the stop.
  rt.reportWork('w1', { state: 'progress', summary: 'back on it' })
  assert.equal(rt.state.works.w1.halted, undefined)
})

test('a Bot that is not a Main Bot is nudged the same way', async (t) => {
  const { rt, agents } = await bench(t).start()
  rt.openWork('w1', { from: 'b', to: 'c' })
  const opened = rt.state.works.w1.at
  rt.sweepResume(opened + 31_000)
  await settle()
  const calls = callsOf(agents, rt.chatOf('c'))
  assert.equal(calls.length, 1)
  assert.match(textOf(calls[0][1]), /w1/)
})

test('a restart picks a waiting chain up from the saved counters', async (t) => {
  const { home, start } = bench(t)
  const first = await start()
  first.rt.openWork('w1', { from: 'a', to: 'b' })
  const opened = first.rt.state.works.w1.at
  first.rt.sweepResume(opened + 10_000)
  assert.equal(first.rt.state.works.w1.resume.nextAt, opened + 30_000)
  await first.stop()
  // The saved team still names the open work and when it is due.
  const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  assert.equal(saved.works.w1.resume.nextAt, opened + 30_000)
  const second = await start()
  assert.equal(second.rt.sweepResume(opened + 40_000), true)
  await settle()
  const calls = callsOf(second.agents, second.rt.chatOf('b'))
  assert.equal(calls.length, 1, 'the watchdog nudges a chain the restart left behind')
  assert.equal(calls[0][1].source.role, 'work-continue')
  assert.equal(second.rt.state.works.w1.resume.attempts, 1)
})

test('the audit and the work history keep every attempt', async (t) => {
  const { rt } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  const opened = rt.state.works.w1.at
  rt.sweepResume(opened + 31_000)
  await settle()
  const entry = rt.resumeAudit().find(item => item.kind === 'continue')
  assert.equal(entry.work, 'w1')
  assert.equal(entry.bot, 'Writer')
  assert.equal(entry.attempt, 1)
  assert.equal(entry.max, 3)
  assert.equal(rt.workHistory('w1').filter(event => event.event === 'resumed').length, 1)
  // Closing the work keeps how often it had to be nudged, next to its final state.
  rt.closeWork('w1', 'Writer', 'done')
  const closed = rt.state.workLog.at(-1)
  assert.equal(closed.final, 'ready')
  assert.deepEqual(closed.resume, { attempts: 1 })
})

test('the host delivers the nudge into the owner’s own chat, not a group', async (t) => {
  const { rt, agents } = await bench(t).start()
  rt.openWork('w1', { from: 'a', to: 'b' })
  const opened = rt.state.works.w1.at
  rt.sweepResume(opened + 31_000)
  await settle()
  assert.equal(callsOf(agents, rt.chatOf('b')).length, 1)
  assert.equal(callsOf(agents, rt.chatOf('a')).length, 0, 'the asker is not nudged')
})
