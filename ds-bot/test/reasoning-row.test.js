import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The Bot chat's assistant cell must show a turn's reasoning where a reader can see it.
// DSH folds a finished turn's process block — which holds the reasoning steps — so the
// row has to ride the step that closes the turn, beside its reply. The data mirrors what
// the DSH chat projects: a reasoning block and a text block on the step.

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
const { AssistantCell, ThinkingRow } = module.exports

const find = (node, match) => {
  if (Array.isArray(node)) return node.flatMap(child => find(child, match))
  if (node === null || typeof node !== 'object') return []
  return [...(match(node) ? [node] : []), ...find(node.children, match)]
}
const nameOf = node => node.type?.name ?? node.type
const rows = out => find(out, node => nameOf(node) === 'ThinkingRow')
const detailsOf = row => ThinkingRow(row.props)

const turn = { turn: 3, status: 'closed', end: { time: 9_000 } }
const thinking = 'The brief is short, so one pass is enough.'
const step = ({ n = 1, blocks, status = 'done' } = {}) => ({
  turn: 3, step: n, seq: 20 + n, status, time: 1_000,
  blocks: blocks ?? [
    { kind: 'reasoning', text: thinking },
    { kind: 'text', text: 'Done.' },
  ],
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

test('the step that closes a turn shows its reasoning beside the reply', () => {
  const data = step()
  const [row] = rows(AssistantCell(props({ data, groupPart: 'response' })))
  assert.equal(row.props.text, thinking)
})

test('a settled step with reply text does not repeat its reasoning inside the process block', () => {
  const data = step()
  assert.equal(rows(AssistantCell(props({ data, groupPart: 'reasoning' }))).length, 0)
})

test('a turn whose closing step has no reasoning still shows the turn earlier thinking', () => {
  const first = step({ n: 1, blocks: [{ kind: 'reasoning', text: thinking }, { kind: 'tool-call', name: 'bash', callId: 'c1', argsRaw: '{}' }] })
  const closing = step({ n: 2, blocks: [{ kind: 'text', text: 'Done.' }] })
  const [row] = rows(AssistantCell(props({ data: closing, steps: [first, closing], groupPart: 'response' })))
  assert.equal(row.props.text, thinking)
})

test('only the closing step carries the row, not the earlier steps', () => {
  const first = step({ n: 1 })
  const closing = step({ n: 2, blocks: [{ kind: 'text', text: 'Done.' }] })
  assert.equal(rows(AssistantCell(props({ data: first, steps: [first, closing], groupPart: 'reasoning' }))).length, 0)
  assert.equal(rows(AssistantCell(props({ data: closing, steps: [first, closing], groupPart: 'response' }))).length, 1)
})

test('a step that is still thinking opens the row on its reasoning part', () => {
  const live = step({ blocks: [{ kind: 'reasoning', text: thinking }], status: 'running' })
  const [row] = rows(AssistantCell(props({ data: live, steps: [live], groupPart: 'reasoning' })))
  assert.equal(row.props.live, true)
  assert.equal(detailsOf(row).props.open, true)
  assert.equal(row.props.text, thinking)
})

test('a settled row starts closed, so history stays quiet', () => {
  const data = step()
  const [row] = rows(AssistantCell(props({ data, groupPart: 'response' })))
  assert.equal(detailsOf(row).props.open, false)
})

test('with thinking turned off no reasoning row is drawn', () => {
  const data = step()
  assert.equal(rows(AssistantCell(props({ data, groupPart: 'response', thinking: false }))).length, 0)
})

test('a step whose reasoning is only a signature shows no reasoning row', () => {
  const silent = step({ blocks: [{ kind: 'reasoning', text: '<signature>abc</signature>' }, { kind: 'text', text: 'Done.' }] })
  assert.equal(rows(AssistantCell(props({ data: silent, steps: [silent], groupPart: 'response' }))).length, 0)
})
