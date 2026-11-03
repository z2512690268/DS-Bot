import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The Bot chat draws a step the way DSH's own chat does: a thinking block of its own,
// above that step's content, then the tool lines of that step as their own rows and the
// reply last. These tests hold that structure and order, not only the text.

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/cells.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const effects = []
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, AbortController, fetch,
  require: (name) => {
    const platform = {
      react: {
        createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
        useContext: ctx => ctx.value, useCallback: fn => fn, useId: () => 'dv-id',
        useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [initial, () => {}], useEffect: (run) => { effects.push(run) },
        useRef: current => ({ current }), useLayoutEffect: () => {}, useMemo: make => make(), Fragment: 'fragment',
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': { MarkdownText: () => null },
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { AssistantCell, ThinkingRow, ToolCell } = module.exports

const walk = (node, out = []) => {
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out }
  if (node === null || typeof node !== 'object') return out
  out.push(node)
  walk(node.children, out)
  return out
}
const nameOf = node => (node === null ? 'null' : node.type?.name ?? node.type)
const ofType = (out, name) => walk(out).filter(node => nameOf(node) === name)

const turn = { turn: 3, status: 'closed', end: { time: 90_000 } }
const thinking = 'The brief is short, so one pass is enough.'
const toolBlock = { kind: 'tool-call', name: 'bash', callId: 'c1', argsRaw: '{}' }
const step = ({ n = 1, blocks, status = 'done', time = 1_000, settled = true } = {}) => ({
  turn: 3, step: n, seq: 20 + n, status, time,
  blocks: blocks ?? [{ kind: 'reasoning', text: thinking }, { kind: 'text', text: 'Done.' }],
  ...(settled ? { finalNode: { seq: 30 + n, time: time + 42_000 } } : {}),
})
const props = ({ data, steps, groupPart, thinking: allowed = true } = {}) => ({
  node: { key: 'n20', location: { kind: 'step', turn }, data },
  groupPart,
  sessionId: 'b',
  openFile: () => {},
  fileMentions: () => undefined,
  useTurnData: () => undefined,
  useRoster: select => select({ bots: [], byId: {}, roomsById: {}, exchangeTurns: {}, prefs: { thinking: allowed } }),
  useUi: () => null,
  useTurnSteps: () => (steps === undefined ? [data] : steps),
  useTurnContext: () => [],
  actions: { noteLive() {} },
})

test('each step gets its own thinking block, above that step content', () => {
  const first = step({ n: 1, blocks: [{ kind: 'reasoning', text: 'First thought' }, toolBlock] })
  const second = step({ n: 2, blocks: [{ kind: 'reasoning', text: 'Second thought' }, { kind: 'text', text: 'Done.' }] })
  const out = AssistantCell(props({ data: second, steps: [first, second], groupPart: 'reasoning' }))
  const row = ofType(out, 'ThinkingRow')[0]
  assert.equal(row.props.text, 'Second thought')
  // The first step's thinking is not collected into the second step's block.
  assert.notEqual(row.props.text, 'First thought\n\nSecond thought')
})

// The chat draws a step in parts: DSH emits the reasoning part, then the response part,
// and the step's tool calls follow as their own nodes. Rendering those parts in that
// order is what puts the thinking block above the reply.
const sequenceOfStep = data => ['reasoning', 'response']
  .flatMap(part => walk(AssistantCell(props({ data, groupPart: part }))))

test('the thinking block comes before the reply text in the flow of a step', () => {
  const sequence = sequenceOfStep(step())
  const thinkingAt = sequence.findIndex(node => nameOf(node) === 'ThinkingRow')
  const replyAt = sequence.findIndex(node => nameOf(node) === 'Bubbles')
  assert.ok(thinkingAt >= 0, 'the step draws no thinking block')
  assert.ok(replyAt >= 0, 'the step draws no reply text')
  assert.ok(thinkingAt < replyAt, 'the reply text comes before the thinking block')
})

test('the thinking block and the reply are separate containers', () => {
  const data = step()
  const reasoningPart = AssistantCell(props({ data, groupPart: 'reasoning' }))
  const responsePart = AssistantCell(props({ data, groupPart: 'response' }))
  const [row] = ofType(reasoningPart, 'ThinkingRow')
  const details = ThinkingRow(row.props)
  assert.equal(nameOf(details), 'details')
  assert.equal(details.props.className, 'bt-think')
  // Reply text lives in the response part only, never inside the thinking block.
  assert.equal(ofType(reasoningPart, 'Bubbles').length, 0)
  assert.equal(ofType(details, 'Bubbles').length, 0)
  assert.equal(ofType(responsePart, 'Bubbles').length, 1)
  assert.equal(ofType(responsePart, 'ThinkingRow').length, 0)
})

test('a tool call of that step stays its own row, outside the thinking block', () => {
  const data = step({ n: 1, blocks: [{ kind: 'reasoning', text: thinking }, toolBlock] })
  const out = AssistantCell(props({ data, groupPart: 'reasoning' }))
  const [row] = ofType(out, 'ThinkingRow')
  assert.equal(ofType(ThinkingRow(row.props), 'ToolCell').length, 0)
  // DSH's own chat ignores tool-call blocks in the message body, and so does this cell:
  // the tool renders through its own node (ToolCell) beside it.
  assert.equal(typeof ToolCell, 'function')
  assert.equal(ofType(out, 'ToolCell').length, 0)
})

test('the folded title carries the step own span', () => {
  const data = step({ time: 1_000 })  // finalNode 42s later
  const [row] = ofType(AssistantCell(props({ data, groupPart: 'reasoning' })), 'ThinkingRow')
  const details = ThinkingRow(row.props)
  const summary = details.children[0]
  assert.equal(summary.children[0], 'Thought it through')
  const time = summary.children.filter(child => nameOf(child) === 'span')[0]
  assert.equal(time?.children.join(''), '· 42s')
})

test('a step still thinking opens the block and ticks from its first chunk', () => {
  const live = step({ blocks: [{ kind: 'reasoning', text: thinking }], status: 'running', settled: false })
  const [row] = ofType(AssistantCell(props({ data: live, steps: [live], groupPart: 'reasoning' })), 'ThinkingRow')
  const details = ThinkingRow(row.props)
  assert.equal(details.props.open, true)
  assert.equal(details.children[0].children[0], 'Thinking')
  assert.equal(nameOf(details.children[0].children[1]), 'Elapsed')
  assert.equal(row.props.at, live.time)
})

test('a settled step starts folded, so history stays quiet', () => {
  const data = step()
  const [row] = ofType(AssistantCell(props({ data, groupPart: 'reasoning' })), 'ThinkingRow')
  assert.equal(ThinkingRow(row.props).props.open, false)
})

test('each step keeps its own folded state, so expanding one leaves the others', () => {
  const first = step({ n: 1, blocks: [{ kind: 'reasoning', text: 'First thought' }, toolBlock] })
  const second = step({ n: 2, blocks: [{ kind: 'reasoning', text: 'Second thought' }, { kind: 'text', text: 'Done.' }] })
  const firstRow = ofType(AssistantCell(props({ data: first, steps: [first, second], groupPart: 'reasoning' })), 'ThinkingRow')[0]
  const secondRow = ofType(AssistantCell(props({ data: second, steps: [first, second], groupPart: 'reasoning' })), 'ThinkingRow')[0]
  assert.notEqual(firstRow.props.viewKey, secondRow.props.viewKey)
})

test('a settled reply does not repeat its step reasoning below the thinking block', () => {
  const data = step()
  assert.equal(ofType(AssistantCell(props({ data, groupPart: 'response' })), 'ThinkingRow').length, 0)
})

test('with thinking turned off no thinking block is drawn', () => {
  const data = step()
  assert.equal(ofType(AssistantCell(props({ data, groupPart: 'reasoning', thinking: false })), 'ThinkingRow').length, 0)
})

test('a step whose reasoning is only a signature shows no thinking block', () => {
  const silent = step({ blocks: [{ kind: 'reasoning', text: '<signature>abc</signature>' }, { kind: 'text', text: 'Done.' }] })
  assert.equal(ofType(AssistantCell(props({ data: silent, steps: [silent], groupPart: 'reasoning' })), 'ThinkingRow').length, 0)
})
