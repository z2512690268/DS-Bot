// A Bot Session is scoped with the team tools when its Agent is created. A tool that
// joins the team later — the browser plugin mounts after the tools module — still has
// to reach a Session that is already scoped, or the Bot never sees it.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const seed = () => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
  },
  rooms: {}, agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, works: {}, requests: {}, prefs: {}, revision: 0,
})

function start(t) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-scope-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed()))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  return { rt }
}

// The part of an Agent the scoping touches: its Session id, a tool registry, and
// the listeners a scope may add.
function agentFor(sessionId) {
  const registered = []
  const agent = {
    session: { id: sessionId },
    ctx: {
      tools: {
        register(def) { registered.push(def.name); return () => {} },
        restrict() { return () => {} },
      },
      on() { return () => {} },
    },
  }
  return { agent, registered }
}

test('a tool that joins the team later still reaches an already scoped Bot Session', async (t) => {
  const { rt } = start(t)
  await rt.load()
  const { agent, registered } = agentFor('b')
  rt.hideBotUnusedTools(agent)
  const first = registered.length
  assert.ok(first > 0, 'the team tools are served on the first scope')
  assert.equal(registered.includes('browser_open'), false, 'no browser tool before the plugin mounts')

  // What browser-plugins.js does after the tools module already scoped this Session.
  rt.teamTools.push({ name: 'browser_open', description: 'open', execute: async () => 'ok' })
  rt.hideBotUnusedTools(agent)

  assert.ok(registered.includes('browser_open'), 'the late tool is served to the same Session')
  assert.equal(registered.filter(name => name === 'browser_open').length, 1, 'and served only once')
})

test('a Session that is not a Bot gets none of the late tools', async (t) => {
  const { rt } = start(t)
  await rt.load()
  const { agent, registered } = agentFor('stranger')
  rt.hideBotUnusedTools(agent)
  rt.teamTools.push({ name: 'browser_open', description: 'open', execute: async () => 'ok' })
  rt.hideBotUnusedTools(agent)
  assert.equal(registered.length, 0)
})
