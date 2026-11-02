// How full the Main Bot's context is: from the tokens its last call spent, against the
// window its model names. Read into the state payload and one quiet line in the panel.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { CONTEXT_SPLIT_RATIO, contextBudgetOf } from '../src/host/usage.js'

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

// One call in the usage ledger, as usage.js writes it: the schema and the version are
// the ledger's own, so the host reads this file exactly as it reads a real one.
function usageAt(home, rows) {
  const db = new DatabaseSync(join(home, 'usage.sqlite'))
  try {
    db.exec(`
      PRAGMA user_version = 3;
      CREATE TABLE calls (key TEXT PRIMARY KEY, session TEXT NOT NULL, time INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL, live INTEGER NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, output INTEGER NOT NULL);
      CREATE TABLE marks (session TEXT PRIMARY KEY, through INTEGER NOT NULL, fold TEXT NOT NULL, sealed INTEGER NOT NULL, listed INTEGER);
      CREATE TABLE owners (session TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE kinds (session TEXT PRIMARY KEY, kind TEXT NOT NULL);`)
    const put = db.prepare('INSERT INTO calls (key, session, time, provider, model, kind, live, input, cache_read, cache_write, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    for (const [at, row] of rows.entries()) {
      put.run(row.key ?? `k${at}`, row.session, row.time, row.provider, row.model, 'bot', row.live ?? 0, row.input, row.cacheRead ?? 0, row.cacheWrite ?? 0, row.output ?? 0)
    }
  } finally {
    db.close()
  }
}

async function startHost(home, { listModels = [], resolveModelInfo = async () => ({}) } = {}) {
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
    llm: {
      listProviders: () => [],
      listModels: async () => listModels,
      resolveModelInfo,
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
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  const tool = (name, args, sessionId) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId } })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json()
  await tool('list_bots', {}, 'a')
  return { rt, call, stop: async () => { await ctx.dispose() } }
}

function bench(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-context-budget-'))
  const hosts = []
  t.after(async () => {
    for (const host of hosts.reverse()) await host.stop()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return { home, start: async (options) => { const host = await startHost(home, options); hosts.push(host); return host } }
}

test('the share is the last call against the model window, and past 70% it asks to split', () => {
  assert.equal(CONTEXT_SPLIT_RATIO, 0.7)
  // input + what the cache supplied + what was written back + the answer
  assert.deepEqual(contextBudgetOf({ input: 100, cacheRead: 20, cacheWrite: 5, output: 3 }, 1_000),
    { tokens: 128, window: 1_000, percent: 13, split: false })
  assert.deepEqual(contextBudgetOf({ input: 140_000, cacheRead: 0, cacheWrite: 0, output: 1_000 }, 200_000),
    { tokens: 141_000, window: 200_000, percent: 71, split: true })
  // A model that cannot name its window: the size is still known.
  assert.deepEqual(contextBudgetOf({ input: 298_300 }, undefined), { tokens: 298_300 })
  assert.deepEqual(contextBudgetOf({ input: 1_000 }, 0), { tokens: 1_000 })
})

test('the Main Bot\'s own last call fills the state payload', async (t) => {
  const benchOf = bench(t)
  usageAt(benchOf.home, [{ session: 'a', time: 5_000, provider: 'deepseek', model: 'v4', input: 150_000, cacheRead: 0, output: 1_000 }])
  const host = await benchOf.start({ resolveModelInfo: async () => ({ context: { contextWindow: 200_000 } }) })
  await host.rt.refreshContextBudget()
  const budget = host.rt.contextBudgetView()
  assert.deepEqual([budget.bot, budget.botId, budget.sessionId, budget.tokens, budget.window, budget.percent, budget.split],
    ['Chief', 'a', 'a', 151_000, 200_000, 76, true])
  const answer = await host.call('state', {})
  assert.equal(answer.ok, true)
  assert.deepEqual([answer.value.contextBudget.percent, answer.value.contextBudget.split], [76, true])
})

test('a window the model cannot name leaves the absolute size only', async (t) => {
  const benchOf = bench(t)
  usageAt(benchOf.home, [{ session: 'a', time: 5_000, provider: 'deepseek', model: 'v4', input: 298_300, cacheRead: 0, output: 0 }])
  const host = await benchOf.start({ resolveModelInfo: async () => ({}) })
  await host.rt.refreshContextBudget()
  assert.deepEqual(host.rt.contextBudgetView().percent, undefined)
  assert.equal(host.rt.contextBudgetView().tokens, 298_300)
  assert.equal(host.rt.contextBudgetView().split, undefined)
})

test('no call in the Main Bot\'s chat means no line at all', async (t) => {
  const benchOf = bench(t)
  usageAt(benchOf.home, [{ session: 'b', time: 5_000, provider: 'deepseek', model: 'v4', input: 9_000 }])
  const host = await benchOf.start()
  await host.rt.refreshContextBudget()
  assert.equal(host.rt.contextBudgetView(), null)
  const answer = await host.call('state', {})
  assert.equal(answer.value.contextBudget, null)
})
