// The "needs you" block renders the whole inbox at once: every row, a batch ignore for
// the works, and an answer field that stays closed until the user opens one or all.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

// A minimal React stand-in: the block is a plain function component, so its tree can be
// read without a renderer. `useState` keeps its first value, which is what a first
// paint shows.
const { outputFiles } = await build({
  stdin: { contents: "export { NeedsYou, healthLineOf, historyLines } from './src/client/need-you.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: Symbol('Fragment'),
  useState: initial => [initial, () => {}],
}
const dom = new JSDOM('<!doctype html><body></body>')
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports, document: dom.window.document, window: dom.window,
  require: name => (name === 'react' ? react : {}),
})
const { NeedsYou, healthLineOf, historyLines } = module.exports

const flat = (children) => children.flatMap(child => (Array.isArray(child) ? flat(child) : child === undefined || child === null || child === false ? [] : [child]))
const nodes = node => (node !== null && typeof node === 'object' ? [node, ...flat(node.props?.children ?? []).flatMap(nodes)] : [])
const textOf = node => flat(node.props?.children ?? []).map(child => (typeof child === 'string' ? child : textOf(child))).join('')
const buttons = tree => nodes(tree).filter(node => node.type === 'button')
const byText = (tree, text) => buttons(tree).find(node => textOf(node) === text)

const items = () => [
  { kind: 'answer', botId: 'a', bot: 'Chief', sessionId: 'a', questionId: 'q1', question: 'Which way?', since: 1, key: 'answer:q1', options: [{ label: 'Left' }], allowCustom: true },
  { kind: 'blocked', botId: 'a', bot: 'Chief', work: 'w1', summary: 'needs a key', since: 2, key: 'blocked:w1' },
  { kind: 'review', botId: 'b', bot: 'Writer', work: 'w2', summary: 'done and usable', since: 3, key: 'review:w2' },
  { kind: 'proposed', botId: 'b', bot: 'Writer', work: 'w3', summary: 'rewrite the changelog', proposed: true, to: 'Tester', since: 4, key: 'proposed:w3' },
]

test('the block shows the whole inbox, not the first few rows', () => {
  const tree = NeedsYou({ items: items(), onOpen() {}, onAnswer() {}, onIgnore() {} })
  assert.equal(textOf(tree) === '', false)
  const rows = nodes(tree).filter(node => node.props?.className === 'bt-needs-row')
  assert.equal(rows.length, 4)
  assert.deepEqual(rows.map(row => row.props['data-kind']),
    ['answer', 'blocked', 'review', 'proposed'])
  assert.match(textOf(tree), /4/)
  assert.equal(textOf(tree).includes('more'), false, 'nothing is left out as "N more"')
  // The proposed row says what the Bot would have done and who it was for.
  assert.match(rows[3].props.title, /Tester/)
})

test('the answer field is closed until the user opens one or all', () => {
  const tree = NeedsYou({ items: items(), onOpen() {}, onAnswer() {}, onIgnore() {} })
  assert.equal(nodes(tree).some(node => node.props?.className === 'bt-needs-answers'), false)
  assert.ok(byText(tree, 'Answer'), 'each question has its own answer toggle')
  assert.ok(byText(tree, 'Expand all'), 'and every field opens at once')
})

test('ignoring several works at once sends every work key, never a question', () => {
  const ignored = []
  const tree = NeedsYou({
    items: items(),
    onOpen() {},
    onAnswer() {},
    onIgnore: keys => ignored.push(keys),
  })
  const batch = byText(tree, 'Ignore 3')
  assert.ok(batch, 'one button clears the three works')
  batch.props.onClick()
  assert.deepEqual(ignored.map(keys => [...keys]), [['blocked:w1', 'review:w2', 'proposed:w3']])
  // One row can be cleared on its own too.
  const row = nodes(tree).find(node => node.props?.['data-kind'] === 'blocked')
  const line = nodes(tree).find(node => node.props?.className === 'bt-needs-line' && nodes(node).some(child => child.props?.['data-kind'] === 'blocked'))
  const close = buttons(line).find(node => textOf(node) === '×')
  close.props.onClick()
  assert.deepEqual([...ignored.at(-1)], ['blocked:w1'])
  assert.ok(row, 'the row is still rendered by this paint')
})

test('a healthy team shows nothing at all', () => {
  assert.equal(NeedsYou({ items: [], onOpen() {}, onAnswer() {}, onIgnore() {} }), null)
  assert.equal(NeedsYou({ onOpen() {} }), null)
  assert.equal(healthLineOf({ stalled: 0, deliveryFailures: 0, answerFailures: 0 }), undefined)
  assert.equal(healthLineOf(null), undefined)
  assert.equal(healthLineOf({ stalled: 1, deliveryFailures: 0, answerFailures: 0 }), '1 stalled')
})

test('the health line says what is wrong, and stays quiet about what is well', () => {
  assert.equal(healthLineOf({ stalled: 0, deliveryFailures: 2, answerFailures: 1 }), '2 failed deliveries · 1 failed answer')
  assert.equal(healthLineOf({ stalled: 0, deliveryFailures: 1, answerFailures: 0 }), '1 failed delivery')
  const tree = NeedsYou({ items: [], health: { stalled: 2, deliveryFailures: 0, answerFailures: 0 }, onOpen() {}, onAnswer() {}, onIgnore() {} })
  assert.ok(tree, 'a stalled team shows the health line even with no rows')
  assert.match(textOf(tree), /2 stalled/)
  assert.equal(NeedsYou({ items: [], health: { stalled: 0, deliveryFailures: 0, answerFailures: 0 }, onOpen() {} }), null)
})

test('one work\'s history reads as a timeline from the moment it was opened', () => {
  const item = {
    kind: 'blocked', work: 'w1', summary: 'needs a key',
    history: [
      { at: 1_000, event: 'created', authority: 'asked' },
      { at: 61_000, event: 'progress', summary: 'reading the file' },
      { at: 184_000, event: 'blocked', summary: 'needs a key' },
    ],
  }
  assert.deepEqual(historyLines(item).map(line => [line.time, line.text]), [
    ['0s', 'Created'],
    ['1m 0s', 'Progress: reading the file'],
    ['3m 3s', 'Blocked: needs a key'],
  ])
  assert.equal(historyLines({ kind: 'blocked', work: 'w2' }).length, 0)
  const { historyLines: closed } = module.exports
  assert.deepEqual(closed({
    kind: 'blocked', work: 'w3',
    history: [{ at: 0, event: 'created' }, { at: 5_000, event: 'closed', final: 'ready' }],
  }).map(line => line.text), ['Created', 'Ended: Ready'])
})
