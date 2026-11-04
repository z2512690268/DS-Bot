import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { previousReasoning } from '../src/client/turn-reasoning.js'

// While a turn runs and its step already streams reasoning, the transcript shows the
// thinking itself; the activity row must step aside instead of repeating a fixed phrase.
// Only a step without reasoning yet falls back to the phrase.

const stub = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value, useCallback: fn => fn, useId: () => 'id',
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  useState: initial => [initial, () => {}], useEffect: (run) => { stub.effects.push(run) }, useLayoutEffect: () => {},
  useRef: current => ({ current }), useMemo: make => make(), Fragment: 'fragment',
  effects: [],
}
const platform = {
  react: stub,
  'react-dom': { createPortal: node => node },
  '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
}
const bundleOf = async entry => {
  const out = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, format: 'cjs', platform: 'node', write: false, external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })
  const module = { exports: {} }
  runInNewContext(out.outputFiles[0].text, { module, exports: module.exports, AbortController, fetch, document: { querySelector: () => null }, window: {}, MutationObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, require: name => platform[name] ?? {} })
  return module.exports
}
const cells = await bundleOf('../src/client/cells.js')
const rows = await bundleOf('../src/client/activity-row.js')

const step = ({ status = 'running', blocks } = {}) => ({
  turn: 1, step: 2, seq: 20, status, time: 1_000,
  blocks: blocks ?? [{ kind: 'reasoning', text: 'Working through the options.' }],
})
const props = ({ data, actions, steps }) => ({
  node: { key: 'n20', location: { kind: 'step', turn: { turn: 1, status: 'open' } }, data },
  groupPart: 'reasoning',
  sessionId: 'b',
  openFile: () => {},
  fileMentions: () => undefined,
  useTurnData: () => undefined,
  useRoster: select => select({ bots: [], byId: {}, roomsById: {}, exchangeTurns: {}, prefs: { thinking: true } }),
  useUi: () => null,
  useTurnSteps: () => steps ?? [data],
  useTurnContext: () => [],
  actions,
})

test('a running step with reasoning reports the thinking as showing', () => {
  const note = cells.reasoningNote({ hidden: false, running: true, reasoning: 'text', texts: [] })
  assert.equal(note?.reasoning, true)
})

test('nothing is reported when the step has no reasoning yet, is settled, or is hidden', () => {
  assert.equal(cells.reasoningNote({ hidden: false, running: true, reasoning: '', texts: [] }), null)
  assert.equal(cells.reasoningNote({ hidden: false, running: false, reasoning: 'text', texts: [] }), null)
  assert.equal(cells.reasoningNote({ hidden: true, running: true, reasoning: 'text', texts: [] }), null)
  // A step that already writes its reply is the streaming-text case, not this one.
  assert.equal(cells.reasoningNote({ hidden: false, running: true, reasoning: 'text', texts: ['x'] }), null)
})

test('the assistant cell publishes that note while the reasoning streams', () => {
  stub.effects.length = 0
  const noted = []
  const data = step()
  cells.AssistantCell(props({ data, actions: { noteLive: (...args) => noted.push(args) } }))
  for (const effect of stub.effects) effect()
  const published = noted.map(args => args[2]).filter(entry => entry !== null && entry !== undefined)
  assert.ok(published.some(entry => entry.reasoning === true), `no reasoning note: ${JSON.stringify(noted)}`)
})

test('a reasoning note is not mistaken for a running tool', () => {
  assert.deepEqual(rows.toolEntries([{ reasoning: true }, { text: true }, { label: 'Running shell commands' }]).map(entry => entry.label ?? Object.keys(entry)[0]), ['Running shell commands'])
})

test('the activity row hides while reasoning streams and returns when a tool runs', () => {
  const base = { running: true, tools: [], relaying: false, bot: { id: 'b' } }
  assert.equal(rows.rowVisible({ ...base, streaming: true }), false)
  assert.equal(rows.rowVisible({ ...base, streaming: true, tools: [{ label: 'Running shell commands' }] }), true)
  assert.equal(rows.rowVisible({ ...base, streaming: false }), true)
})

test('the latest earlier reasoning answers for an answer step that has none', () => {
  const first = { turn: 1, step: 1, blocks: [{ kind: 'reasoning', text: 'Step one thought' }, { kind: 'tool-call', name: 'bash' }] }
  const second = { turn: 1, step: 2, blocks: [{ kind: 'reasoning', text: 'Step two thought' }] }
  const answer = { turn: 1, step: 3, blocks: [{ kind: 'text', text: 'Done' }] }
  assert.equal(previousReasoning([first, second, answer], answer), 'Step two thought')
  assert.equal(previousReasoning([first, second], first), '')
  assert.equal(previousReasoning([], answer), '')
})

test('a running answer step without reasoning keeps the turn thinking on screen', () => {
  stub.effects.length = 0
  const noted = []
  const earlier = { turn: 1, step: 1, seq: 10, status: 'settled', time: 500, blocks: [{ kind: 'reasoning', text: 'Earlier thinking' }] }
  const answer = { turn: 1, step: 2, seq: 20, status: 'running', time: 900, blocks: [{ kind: 'reasoning', text: '' }] }
  const out = cells.AssistantCell(props({ data: answer, steps: [earlier, answer], actions: { noteLive: (...args) => noted.push(args) } }))
  const rows = []
  const walk = node => { if (Array.isArray(node)) return node.forEach(walk); if (!node || typeof node !== 'object') return; rows.push(node); (node.children ?? []).forEach(walk) }
  walk(out)
  const row = rows.find(node => node.type?.name === 'ThinkingRow')
  assert.equal(row?.props.text, 'Earlier thinking')
  for (const effect of stub.effects) effect()
  assert.ok(noted.some(args => args[2]?.reasoning === true), 'no reasoning note for the carried thinking')
})
