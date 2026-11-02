// A report from a real turn, all the way through the turn machinery: the card it
// opens has to reach the asker's chat, with the choices the report named.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { REPLY_KIND, SOURCE_KIND } from '../src/host/constants.js'

const team = () => ({
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

async function start(seed) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-work-card-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const messages = []
      agents.set(sessionId, {
        session: { id: sessionId, requestHeader: () => undefined, deriveMessages: () => messages },
        id: sessionId,
        calls,
        status: 'idle',
        followup(message) { calls.push(['followup', message]) },
        steer(message) { calls.push(['steer', message]) },
        inject(message) { calls.push(['inject', message]) },
        cancel(cause) { calls.push(['cancel', cause]) },
        async whenIdle() {},
        async runMaintenance(fn) { return fn(AbortSignal.timeout(60_000)) },
        inbox: {
          nextStep: [],
          nextTurn: [],
          remove(id) {
            for (const list of [this.nextStep, this.nextTurn]) {
              const at = list.findIndex(message => message.id === id)
              if (at !== -1) return list.splice(at, 1).length === 1
            }
            return false
          },
        },
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
    sessions: { flush: async () => {}, messageProjections: [] },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  await tool('list_bots', {}, 'a')
  return { rt, tool, call, emit, stop }
}

const textBlock = text => [{ type: 'text', text }]

// The whole path a live reply takes: the request claim, the report, the answer and the
// turn's end. The card has to be there afterwards, in the chat of the Bot that asked.
test('a report from a claimed turn opens the card in the asker chat', async (t) => {
  const { rt, tool, emit, stop } = await start(team())
  t.after(stop)
  await tool('message_bot', { to: 'Writer', message: 'write the thing' }, 'a')
  const work = Object.keys(rt.state.works)[0]
  assert.ok(work, 'the request opened a work')
  emit('b', 'turn/start', { turn: 1 })
  emit('b', 'user/message', {
    content: textBlock('write the thing'),
    source: { kind: SOURCE_KIND, role: 'request', exchangeId: work, senderSessionId: 'a', senderName: 'Chief' },
  })
  assert.match(await tool('report', {
    state: 'blocked', summary: '验证需要你打开一个文件', human_action: '可以先打开 report-check.txt 吗？',
    human_options: ['可以', '等会儿'],
  }, 'b'), /Recorded blocked/)
  emit('b', 'assistant/message', { message: { content: textBlock('我在等你选择。') } })
  emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await new Promise(resolve => setTimeout(resolve, 40))
  const chat = rt.chatOf('a')
  const card = rt.state.questions[chat]
  assert.ok(card, `no card; questions: ${JSON.stringify(Object.keys(rt.state.questions))}; works: ${JSON.stringify(Object.keys(rt.state.works))}`)
  assert.equal(card.question, '可以先打开 report-check.txt 吗？')
  assert.deepEqual(card.options.map(option => option.label), ['可以', '等会儿'])
  assert.equal(card.attention.ownerId, 'b')
  assert.equal(card.attention.askerId, 'a')
  assert.ok(typeof card.attention.work === 'string' && card.attention.work !== '')
})

// A card that a report opened belongs to the user: the reply that comes with the
// report must not answer it, or the user never sees the question.
test('the reply that comes with a report does not clear the card it opened', async (t) => {
  const { rt, emit, stop } = await start(team())
  t.after(stop)
  rt.openWork('w1', { from: 'a', to: 'b' })
  rt.reportWork('w1', {
    state: 'blocked', summary: '验证需要你打开一个文件', human_action: '可以先打开 report-check.txt 吗？',
    human_options: ['可以', '等会儿'],
  })
  rt.closeWork('w1', 'Writer', '我在等你打开那个文件。')
  const chat = rt.chatOf('a')
  const card = rt.state.questions[chat]
  assert.equal(card.question, '可以先打开 report-check.txt 吗？')
  assert.deepEqual(card.options.map(option => option.label), ['可以', '等会儿'])
  assert.equal(card.detail, 'Writer: 验证需要你打开一个文件')
  assert.equal(card.attention.ownerId, 'b')
  assert.equal(card.attention.askerId, 'a')
  assert.ok(typeof card.attention.work === 'string' && card.attention.work !== '')
  // The answer from the Bot that could not go on arrives as a reply in this chat.
  emit('a', 'user/message', { content: textBlock('（回答）'), source: { kind: REPLY_KIND } })
  assert.equal(rt.state.questions[chat], card)
})

test("a card the Bot asked itself is still answered by the user's next message", async (t) => {
  const { rt, emit, stop } = await start(team())
  t.after(stop)
  const chat = rt.chatOf('a')
  rt.state.questions[chat] = { id: 'q1', question: '哪个方向？', options: [{ label: 'A' }, { label: 'B' }], allowCustom: true, askedAt: 1 }
  emit('a', 'user/message', { content: textBlock('A'), source: { kind: 'user' } })
  assert.equal(rt.state.questions[chat], undefined)
})
