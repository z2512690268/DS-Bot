// What the Bot that asked reads from a reply: by default the report line and a pointer
// to the whole reply in a file, so the asking Bot's context does not carry the report;
// the whole text is kept, readable, and the dialog can show it.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { SOURCE_KIND } from '../src/host/constants.js'

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
  works: {},
  requests: {},
  prefs: {},
  revision: 0,
})

async function start(config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-reply-detail-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
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
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  await tool('list_bots', {}, 'a')
  return {
    rt,
    agents,
    emit,
    tool,
    home,
    stop: async () => {
      await ctx.dispose()
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

const textBlock = text => [{ type: 'text', text }]
const textOf = message => message.content.map(block => block.text ?? '').join('')

// A work opened by message_bot and answered by a real turn on the Bot that does it.
async function answeredWork(host, body) {
  await host.tool('message_bot', { to: 'Writer', message: 'write the thing' }, 'a')
  const work = Object.keys(host.rt.state.works)[0]
  host.emit('b', 'turn/start', { turn: 1 })
  host.emit('b', 'user/message', {
    content: textBlock('write the thing'),
    source: { kind: SOURCE_KIND, role: 'request', exchangeId: work, senderSessionId: 'a', senderName: 'Chief' },
  })
  host.emit('b', 'assistant/message', { message: { content: textBlock(body) } })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await new Promise(resolve => setTimeout(resolve, 40))
  return work
}

const replyTo = (host, id = 'a') => host.agents.get(host.rt.chatOf(id)).calls.at(-1)?.[1]

test('a reply reaches the asking Bot as the report line and a pointer to the file', async (t) => {
  const host = await start()
  t.after(host.stop)
  const body = `WORK-DETAIL-${'x'.repeat(1_200)}`
  const work = await answeredWork(host, body)
  const message = replyTo(host)
  const said = textOf(message)
  assert.match(said, /^\[Reply from Writer\]\n\[ready\]/)
  assert.match(said, /\[Full reply: .+\/works\/.+\/reply-1\.md\]/)
  assert.equal(said.includes(body), false, 'the whole report stays out of the asker context')
  // The whole reply is kept, verbatim, where the line points.
  const path = said.match(/\[Full reply: (.+)\]/)[1]
  assert.equal(existsSync(path), true)
  const kept = readFileSync(path, 'utf8')
  assert.ok(kept.includes(body), 'the file holds the whole reply')
  const entry = host.rt.state.exchanges.find(item => item.role === 'reply')
  assert.equal(entry.detail, path)
  assert.ok(entry.detailLength >= body.length)
  assert.equal(host.rt.state.works[work], undefined, 'the work is answered')
  // The exchange dialog reads the whole reply from that file.
  assert.deepEqual(await host.rt.exchangeText(entry), { text: kept, whole: true })
})

test('a blocked reply still says where it is stuck and what the user must do', async (t) => {
  const host = await start()
  t.after(host.stop)
  await host.tool('message_bot', { to: 'Writer', message: 'write the thing' }, 'a')
  const work = Object.keys(host.rt.state.works)[0]
  host.emit('b', 'turn/start', { turn: 1 })
  host.emit('b', 'user/message', {
    content: textBlock('write the thing'),
    source: { kind: SOURCE_KIND, role: 'request', exchangeId: work, senderSessionId: 'a', senderName: 'Chief' },
  })
  assert.match(await host.tool('report', {
    state: 'blocked', summary: '受控文件读不了', human_action: '可以先打开 report-check.txt 吗？',
    human_options: ['可以', '等会儿'],
  }, 'b'), /Recorded blocked/)
  host.emit('b', 'assistant/message', { message: { content: textBlock('我卡在读取权限上。\nNeeds the user: 请把 report-check.txt 的读取权限给我。') } })
  host.emit('b', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await new Promise(resolve => setTimeout(resolve, 40))
  const said = textOf(replyTo(host))
  assert.match(said, /\[reported blocked: 受控文件读不了\]/)
  assert.match(said, /可以先打开 report-check\.txt 吗？/, 'the user action survives')
  assert.match(said, /Needs the user: 请把 report-check\.txt 的读取权限给我。/)
  assert.match(said, /\[Full reply: /)
})

test('the switch puts the whole reply back inline, and keeps no file for it', async (t) => {
  const host = await start({ replyDetail: 'full' })
  t.after(host.stop)
  const body = '全文直接交给派活的 Bot。'
  await answeredWork(host, body)
  const said = textOf(replyTo(host))
  assert.match(said, /^\[Reply from Writer\]\n全文直接交给派活的 Bot。/)
  assert.equal(said.includes('[Full reply:'), false)
  const entry = host.rt.state.exchanges.find(item => item.role === 'reply')
  assert.equal(entry.detail, undefined)
})
