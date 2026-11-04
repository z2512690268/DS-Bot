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
// paint shows; `mount` below gives it a store, for what a click does.
const { outputFiles } = await build({
  stdin: { contents: "export { NeedsYou, healthLineOf, historyLines, visibleItems, statsLineOf, shortDuration, runningLineOf } from './src/client/need-you.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react'],
})
const compiled = outputFiles[0].text
const dom = new JSDOM('<!doctype html><body></body>')
const load = (react) => {
  const module = { exports: {} }
  runInNewContext(compiled, {
    module, exports: module.exports, document: dom.window.document, window: dom.window,
    require: name => (name === 'react' ? react : {}),
  })
  return module.exports
}
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: Symbol('Fragment'),
  useState: initial => [initial, () => {}],
}
const { NeedsYou, healthLineOf, historyLines, visibleItems, statsLineOf, shortDuration, runningLineOf } = load(react)

const flat = (children) => children.flatMap(child => (Array.isArray(child) ? flat(child) : child === undefined || child === null || child === false ? [] : [child]))
// The stand-in does not run components, so the walk does: a component element is
// replaced by the tree its function returns, hooks keeping their first value.
const nodes = (node) => {
  if (node === null || typeof node !== 'object') return []
  if (typeof node.type === 'function') return nodes(node.type(node.props))
  return [node, ...flat(node.props?.children ?? []).flatMap(nodes)]
}
const textOf = node => flat(node.props?.children ?? []).map(child => (typeof child === 'string' ? child : textOf(child))).join('')
const buttons = tree => nodes(tree).filter(node => node.type === 'button')
const byText = (tree, text) => buttons(tree).find(node => textOf(node) === text)

// A mounted block: the tree is drawn again whenever a hook's setter runs, so a click
// can be followed by what the block shows next. Hook calls are numbered in draw order;
// only the top-level hooks are stable between paints, which is all these tests use.
function mount(props) {
  const states = []
  let index = 0
  let current = props
  let element = null
  const draw = () => {
    index = 0
    element = react.createElement(NeedYouComponent, current)
    view = nodes(element)
  }
  let view = null
  const reactWithStore = {
    createElement: react.createElement,
    Fragment: react.Fragment,
    useState: (initial) => {
      const at = index++
      if (states[at] === undefined) states[at] = initial
      return [states[at], (value) => {
        states[at] = typeof value === 'function' ? value(states[at]) : value
        draw()
      }]
    },
  }
  const { NeedsYou: NeedYouComponent } = load(reactWithStore)
  draw()
  return {
    rows: () => view.filter(node => node.props?.['data-kind'] !== undefined),
    button: text => view.find(node => node.type === 'button' && textOf(node) === text),
    clicked: function (text) {
      const button = this.button(text)
      assert.ok(button, `no "${text}" button`)
      button.props.onClick({ stopPropagation() {} })
    },
    settle: () => new Promise(resolve => setTimeout(resolve, 20)),
  }
}

const items = () => [
  { kind: 'answer', botId: 'a', bot: 'Chief', sessionId: 'a', questionId: 'q1', question: 'Which way?', since: 1, key: 'answer:q1', options: [{ label: 'Left' }], allowCustom: true },
  { kind: 'blocked', botId: 'b', bot: 'Writer', sessionId: 'b', work: 'w1', summary: 'needs a key', since: 2, key: 'blocked:w1', askedBy: 'Chief' },
  { kind: 'review', botId: 'b', bot: 'Writer', sessionId: 'b', work: 'w2', summary: 'done and usable', since: 3, key: 'review:w2', askedBy: 'Chief' },
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
  assert.equal(nodes(tree).some(node => node.props?.className?.includes('bt-needs-answer-box') === true), false)
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

test('a blocked or reviewed row answers the Bot that is stuck, and a proposal does not', () => {
  const sent = []
  const tree = NeedsYou({
    items: items(),
    onOpen() {},
    onAnswer() {},
    onSend: (sessionId, text) => sent.push([sessionId, text]),
    onIgnore() {},
  })
  const calls = buttons(tree).filter(node => textOf(node) === 'Go on')
  assert.equal(calls.length, 2, 'one for the blocked row and one for the review')
  calls[0].props.onClick({ stopPropagation() {} })
  assert.deepEqual(sent.map(([sessionId, text]) => [sessionId, text]), [['b', 'Go on: this is handled, retry it.']])
  // The proposal has nothing to go on with: it is approved or ignored, not answered.
  assert.equal(nodes(tree).filter(node => node.props?.['data-kind'] === 'proposed').length, 1)
})

test('a proposal is approved from its row, and a blocked row offers no such thing', () => {
  const approved = []
  const tree = NeedsYou({
    items: items(),
    onOpen() {},
    onAnswer() {},
    onSend() {},
    onApprove: id => approved.push(id),
    onIgnore() {},
  })
  const buttonsWith = text => buttons(tree).filter(node => textOf(node) === text)
  assert.equal(buttonsWith('Approve').length, 1, 'only the proposal can be approved')
  buttonsWith('Approve')[0].props.onClick()
  assert.deepEqual([...approved], ['w3'])
})

test('clicking Go on takes the row away at once, and the host is told to drop it', async () => {
  const sent = []
  const dismissed = []
  const ui = mount({
    items: items(),
    onOpen() {},
    onAnswer() {},
    onSend: (sessionId, text) => { sent.push([sessionId, text]); return Promise.resolve() },
    onApprove() {},
    onIgnore: (keys) => { dismissed.push([...keys]); return Promise.resolve() },
    onError() {},
  })
  assert.equal(ui.rows().filter(row => row.props['data-kind'] === 'blocked').length, 1)
  ui.clicked('Go on')
  // Gone before the host has answered, so the user sees that the row was handled.
  assert.equal(ui.rows().filter(row => row.props['data-kind'] === 'blocked').length, 0, 'the row left at once')
  await ui.settle()
  assert.deepEqual(sent.map(([sessionId, text]) => [sessionId, text]), [['b', 'Go on: this is handled, retry it.']])
  assert.deepEqual(dismissed.map(keys => [...keys]), [['blocked:w1']], 'and the same work is dismissed on the host')
})

test('a reply that failed brings the row back and tells the user', async () => {
  const errors = []
  const ui = mount({
    items: items(),
    onOpen() {},
    onAnswer() {},
    onSend: () => Promise.reject(new Error('the Session is gone')),
    onIgnore: () => Promise.resolve(),
    onApprove() {},
    onError: (error, tag) => errors.push([error?.message, tag]),
  })
  ui.clicked('Go on')
  assert.equal(ui.rows().filter(row => row.props['data-kind'] === 'blocked').length, 0)
  await ui.settle()
  assert.equal(ui.rows().filter(row => row.props['data-kind'] === 'blocked').length, 1, 'the row is back')
  assert.equal(ui.button('Go on') !== undefined, true)
  assert.deepEqual(errors, [['the Session is gone', 'needs-reply']])
})

test('a dismissal the host did not take also brings the row back', async () => {
  const errors = []
  const ui = mount({
    items: items(),
    onOpen() {},
    onAnswer() {},
    onSend: () => Promise.resolve(),
    onIgnore: () => Promise.reject(new Error('cannot save')),
    onApprove() {},
    onError: (error, tag) => errors.push([error?.message, tag]),
  })
  ui.clicked('Go on')
  await ui.settle()
  assert.equal(ui.rows().filter(row => row.props['data-kind'] === 'blocked').length, 1)
  assert.deepEqual(errors, [['cannot save', 'needs-reply']])
})

test('a work that moves on after being handled is news again', async () => {
  const hidden = { 'blocked:w1': 100 }
  assert.equal(visibleItems(items(), hidden).filter(item => item.kind === 'blocked').length, 0)
  const movedOn = items().map(item => (item.kind === 'blocked' ? { ...item, since: 101 } : item))
  assert.equal(visibleItems(movedOn, hidden).filter(item => item.kind === 'blocked').length, 1)
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

test('the day is one quiet line, and a quiet day says nothing', () => {
  assert.equal(statsLineOf(undefined), undefined)
  assert.equal(statsLineOf({ day: { closed: 0, stalled: 0, deliveryFailures: 0, answerFailures: 0 } }), undefined)
  assert.equal(statsLineOf({ day: { closed: 2, medianMs: 90_000, stalled: 1, deliveryFailures: 2, answerFailures: 1 } }),
    'Last 24h: 2 done · median 1m · 1 stalled · 3 failed')
  assert.equal(statsLineOf({ day: { closed: 1, medianMs: 180_000, stalled: 0, deliveryFailures: 0, answerFailures: 0 } }),
    'Last 24h: 1 done · median 3m')
  assert.deepEqual([12_000, 90_000, 3_600_000, 3_960_000].map(shortDuration), ['12s', '1m', '1h', '1h 6m'])
  const tree = NeedsYou({ items: [], stats: { day: { closed: 1, medianMs: 60_000, stalled: 0, deliveryFailures: 0, answerFailures: 0 } }, onOpen() {} })
  assert.ok(tree, 'a day with work shows its line even with no rows')
  assert.match(textOf(tree), /Last 24h: 1 done · median 1m/)
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
  assert.deepEqual(historyLines({
    kind: 'blocked', work: 'w3',
    history: [{ at: 0, event: 'created' }, { at: 5_000, event: 'closed', final: 'ready' }],
  }).map(line => line.text), ['Created', 'Ended: Ready'])
})

// An approval the policy could not decide: the row says what the Bot wants to run, why,
// and why the team could not settle it, and answers through the same inbox.
const approvalItem = (approvals) => [{
  kind: 'approval', botId: 'b', bot: 'Writer', sessionId: 'b', since: 10, key: 'approval:b',
  summary: 'pwsh: escalate sandbox to danger-full-access: install deps',
  unsure: 'no rule covers this request',
  ...(approvals.length > 1 ? { more: approvals.length - 1 } : {}),
  approvals,
}]
const approvalOne = (id, at = 10) => ({ id, tool: 'pwsh', reason: 'escalate sandbox to danger-full-access: install deps', detail: 'npm install --prefix /tmp/profile-copy', unsure: 'no rule covers this request', at })

test('an approval says what it is for, why the team is unsure, and both answers', () => {
  const tree = NeedsYou({ items: approvalItem([approvalOne('ap1')]), onOpen() {}, onApproval() {}, onError() {} })
  assert.match(textOf(tree), /Waiting for approval/)
  assert.match(textOf(tree), /pwsh: escalate sandbox to danger-full-access: install deps/)
  assert.match(textOf(tree), /Not sure: no rule covers this request/)
  assert.match(textOf(tree), /npm install --prefix \/tmp\/profile-copy/, 'the object being escalated is shown')
  assert.ok(byText(tree, 'Allow once'))
  assert.ok(byText(tree, 'Reject'))
  assert.equal(byText(tree, 'History'), undefined, 'an approval has no work history')
})

test('an approval is answered from its row and leaves at once', async () => {
  const answered = []
  const ui = mount({
    items: approvalItem([approvalOne('ap1')]),
    onOpen() {},
    onApproval: (id, choice) => { answered.push([id, choice]); return Promise.resolve() },
    onError() {},
  })
  assert.equal(ui.rows().filter(row => row.props['data-kind'] === 'approval').length, 1)
  ui.clicked('Allow once')
  assert.deepEqual(answered, [['ap1', 'allow']])
  assert.equal(ui.rows().filter(row => row.props['data-kind'] === 'approval').length, 0, 'the row leaves at once')
})

test('an approval answer that failed brings the row back and tells the user', async () => {
  const errors = []
  const ui = mount({
    items: approvalItem([approvalOne('ap1')]),
    onOpen() {},
    onApproval: () => Promise.reject(new Error('This approval is no longer open')),
    onError: (error, tag) => errors.push([error.message, tag]),
  })
  ui.clicked('Reject')
  assert.equal(ui.rows().filter(row => row.props['data-kind'] === 'approval').length, 0)
  await ui.settle()
  assert.equal(ui.rows().filter(row => row.props['data-kind'] === 'approval').length, 1, 'the row is back')
  assert.deepEqual(errors, [['This approval is no longer open', 'approval']])
})

test('several approvals in one chat fold into one row and open one by one', async () => {
  const answered = []
  const ui = mount({
    items: approvalItem([approvalOne('ap1', 10), approvalOne('ap2', 20)]),
    onOpen() {},
    onApproval: (id, choice) => { answered.push([id, choice]); return Promise.resolve() },
    onError() {},
  })
  assert.equal(ui.rows().filter(row => row.props['data-kind'] === 'approval').length, 1, 'one row, not two')
  assert.equal(ui.button('Allow once'), undefined, 'a folded row answers from its list')
  ui.clicked('Answer 2')
  assert.ok(ui.button('Allow once'), 'the list of requests is open')
  ui.clicked('Allow once')
  assert.deepEqual(answered, [['ap1', 'allow']])
  assert.equal(ui.button('Allow once') !== undefined, true, 'the second one is still there')
  ui.clicked('Allow once')
  assert.deepEqual(answered, [['ap1', 'allow'], ['ap2', 'allow']])
  await ui.settle()
  assert.equal(ui.rows().filter(row => row.props['data-kind'] === 'approval').length, 0)
})

test('the batch ignore clears works only, never an approval', () => {
  const tree = NeedsYou({ items: [...items(), ...approvalItem([approvalOne('ap1')])], onOpen() {}, onIgnore() {}, onApproval() {} })
  assert.ok(byText(tree, 'Ignore 3'), 'the three works are cleared together')
  assert.equal(byText(tree, 'Ignore 4'), undefined, 'the approval is not a work to ignore')
})

test('a single click opens the chat; a double-click or Enter opens the card', () => {
  const opened = []
  const focused = []
  const ui = mount({
    items: items(),
    onOpen: id => opened.push(id),
    onOpenCard: item => focused.push([item.kind, item.key]),
    onAnswer() {},
    onSend() {},
    onApprove() {},
    onApproval() {},
    onIgnore: () => Promise.resolve(),
    onError() {},
  })
  const row = ui.rows().find(node => node.props['data-kind'] === 'blocked')
  row.props.onClick()
  assert.deepEqual(opened, ['b'])
  assert.deepEqual(focused, [], 'a single click does not move to the card')
  row.props.onDoubleClick({ stopPropagation() {} })
  assert.deepEqual(focused, [['blocked', 'blocked:w1']])
  const event = { key: 'Enter', preventDefault() { this.prevented = true }, nativeEvent: {} }
  row.props.onKeyDown(event)
  assert.equal(event.prevented, true)
  assert.deepEqual(focused, [['blocked', 'blocked:w1'], ['blocked', 'blocked:w1']])
  // Space and a modified Enter stay with the button.
  row.props.onKeyDown({ key: ' ', preventDefault() {}, nativeEvent: {} })
  row.props.onKeyDown({ key: 'Enter', shiftKey: true, preventDefault() {}, nativeEvent: {} })
  assert.equal(focused.length, 2)
  // A question row points at its question id, not at a work.
  const answer = ui.rows().find(node => node.props['data-kind'] === 'answer')
  answer.props.onKeyDown({ key: 'Enter', preventDefault() {}, nativeEvent: {} })
  assert.deepEqual(focused.at(-1), ['answer', 'answer:q1'])
})

test('the work in flight shows its estimate against the clock, and asks nothing', () => {
  const tree = NeedsYou({
    items: [],
    running: [
      { id: 'w1', bot: 'Writer', askedBy: 'Chief', minutes: 20, elapsedMs: 16 * 60_000, pace: 'due', etaText: '20 minutes' },
      { id: 'w2', bot: 'Researcher', minutes: undefined, elapsedMs: 3 * 60_000, pace: 'unknown', escalated: true },
    ],
    onOpen() {},
  })
  const rows = nodes(tree).filter(node => node.props?.className === 'bt-needs-run')
  assert.equal(rows.length, 2)
  // Behind its estimate is the yellow row; the text is the estimate and the time spent.
  assert.equal(rows[0].props['data-pace'], 'due')
  assert.equal(textOf(rows[0]), 'WriterEst. 20m · in 16m')
  // No estimate is said plainly, and a raised Bot says so.
  assert.equal(rows[1].props['data-pace'], 'unknown')
  assert.equal(textOf(rows[1]), 'ResearcherNo estimate · in 3m · raised')
  // Nothing here is a row to act on: no kind, no buttons, no answer field.
  assert.equal(nodes(tree).some(node => node.props?.['data-kind'] !== undefined), false)
  assert.equal(buttons(tree).length, 0)
  // A team with nothing in flight and nothing waiting stays quiet.
  assert.equal(NeedsYou({ items: [], running: [], onOpen() {} }), null)
})

test('the running line reads the same in both cases', () => {
  assert.equal(runningLineOf({ minutes: 10, elapsedMs: 5 * 60_000 }), 'Est. 10m · in 5m')
  assert.equal(runningLineOf({ elapsedMs: 12_000 }), 'No estimate · in 12s')
})
