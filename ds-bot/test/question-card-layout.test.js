import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// A long question card must keep its whole question in the DOM and keep the options and
// the answer field as their own parts of the card: the card scrolls inside itself rather
// than letting the transcript cut off the top of the question or the bottom of the options.

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/questions.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports, AbortController, fetch,
  require: (name) => {
    const platform = {
      react: {
        createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
        useContext: ctx => ctx.value, useCallback: fn => fn, useId: () => 'q-id',
        useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
        createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
        useState: initial => [initial, () => {}], useEffect: () => {}, useLayoutEffect: () => {},
        useRef: current => ({ current }), useMemo: make => make(), Fragment: 'fragment',
      },
      'react-dom': { createPortal: node => node },
      '@deepseek-ai/dsh-client-ui-primitives': {},
    }
    if (!(name in platform)) throw new Error(`no platform module ${name}`)
    return platform[name]
  },
})
const { PendingQuestion } = module.exports

// Function components are expanded by calling them, like the fake React in other client
// tests: hooks are plain stubs, so a component renders as one element tree.
const walk = (node, out = [], depth = 0) => {
  if (Array.isArray(node)) { for (const child of node) walk(child, out, depth); return out }
  if (node === null || typeof node !== 'object') return out
  if (typeof node.type === 'function' && depth < 40) return walk(node.type({ ...node.props, children: node.children }), out, depth + 1)
  out.push(node)
  walk(node.children, out, depth)
  return out
}
const classNameOf = node => node.props?.className ?? ''
const textOf = node => (node.children ?? []).filter(child => typeof child === 'string').join('')

const question = '我们要在这一轮里决定接下来这台机器上的运行时修复顺序与验证方式：先修 60 秒转后台阈值，还是先修 ask_user 卡片裁切（这里故意写得很长，用来确认题目不会被截断）。'
const options = [
  { label: '选项一：先修 60 秒转后台阈值，再处理 steer 与思考过程的渲染', description: '说明一：改动 profile 与客户端，影响面最大，需要重启。' },
  { label: '选项二：先修 ask_user 卡片裁切，再回头处理 60 秒阈值', description: '说明二：纯客户端改动，验证成本低。' },
  { label: '选项三：两件事并行，按运行时与界面两条线各自推进', description: '说明三：需要两个人手，但最省时间。' },
  { label: '选项四：先都别动，等用户给出优先级再说', description: '说明四：保持现状。' },
]
const actions = { noteHeldCard() {}, answerQuestion() {}, dismissQuestion() {} }
const props = inline => ({ sessionId: 's1', question: { id: 'q1', question, detail: detail(), options, allowCustom: true }, actions, inline, enterToSend: true })
const detail = () => '第一行说明：这张卡片用于验证长文本布局。\n第二行说明：四个选项都很长。\n第三行说明：窄窗口下同样要能看到选项与提交按钮。'
const render = inline => walk(PendingQuestion(props(inline)))

test('a long question keeps its full text, never a truncated head', () => {
  const tree = render(true)
  const title = tree.find(node => classNameOf(node) === 'bt-q-title')
  assert.ok(title, 'no title')
  assert.equal(textOf(title), question)
  assert.equal(textOf(title).length, question.length)
  const detailNode = tree.find(node => classNameOf(node) === 'bt-q-detail')
  assert.equal(textOf(detailNode), detail())
})

test('all options and their descriptions are rendered, with the answer field as a sibling', () => {
  const tree = render(true)
  const card = tree.find(node => classNameOf(node).split(' ').includes('bt-q'))
  const list = tree.find(node => classNameOf(node) === 'bt-q-list')
  const custom = tree.find(node => classNameOf(node) === 'bt-q-custom')
  assert.ok(card && list && custom, 'card, list or answer field missing')
  assert.equal(list.children.filter(child => classNameOf(child) === 'bt-q-opt').length, 4)
  const labels = tree.filter(node => classNameOf(node) === 'bt-q-label').map(textOf)
  assert.deepEqual(labels, options.map(option => option.label))
  const descs = tree.filter(node => classNameOf(node) === 'bt-q-desc').map(textOf)
  assert.deepEqual(descs, options.map(option => option.description))
  // Options and the field are separate parts of the card, not one run of text.
  assert.equal(card.children.includes(list), true)
  assert.equal(card.children.includes(custom), true)
  assert.equal(tree.some(node => classNameOf(node) === 'bt-q-input'), true)
})

// The card is capped and scrolls inside itself, so a question taller than the chat view
// cannot slide its head out of the window or push the options past the fold.
const styles = readFileSync(fileURLToPath(new URL('../src/client/styles.js', import.meta.url)), 'utf8')
const declarations = selector => {
  const escaped = selector.replaceAll('.', '\\.')
  const match = new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(styles)
  assert.ok(match, `no rule for ${selector}`)
  return match[1]
}

test('a long card is capped and scrolls inside itself', () => {
  const card = declarations('.bt-q')
  assert.match(card, /max-height:min\(72vh,620px\)/)
  assert.doesNotMatch(card, /overflow:hidden/)
  const text = declarations('.bt-q-text')
  assert.match(text, /overflow-y:auto/)
  assert.match(text, /min-height:0/)
  const list = declarations('.bt-q-list')
  assert.match(list, /overflow-y:auto/)
  assert.match(list, /min-height:0/)
  const head = declarations('.bt-q-head')
  assert.match(head, /min-height:0/)
})
