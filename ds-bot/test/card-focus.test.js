// The jump a double-click in "needs you" asks for: the card that row points at, found
// in the conversation, scrolled up, unfolded and flashed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cardFocus, cardTargetOf, findCardTarget, focusCard, jumpToCard } from '../src/client/card-focus.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, 'dev', 'harness'), 'package.json'))('jsdom')

const page = () => new JSDOM('<!doctype html><body></body>').window.document

test('a row points at its question card, its approval card, or the newest row', () => {
  assert.deepEqual(cardTargetOf({ kind: 'answer', questionId: 'q1' }),
    { selector: '[data-question-id="q1"]', key: 'question:q1', expand: true })
  assert.deepEqual(cardTargetOf({ kind: 'approval', key: 'approval:b' }),
    { selector: '[data-approval-key]', key: 'approval:b', expand: true })
  for (const kind of ['blocked', 'review', 'proposed']) {
    assert.deepEqual(cardTargetOf({ kind, work: 'w1' }),
      { selector: '[data-chat-flow] > [data-chat-flow-key]', key: 'w1', expand: false, last: true })
  }
})

test('the card is found by its own id, and a work row takes the newest flow row', () => {
  const doc = page()
  doc.body.innerHTML = `
    <div data-chat-flow>
      <div data-chat-flow-key="k1">first</div>
      <div data-chat-flow-key="k2">second</div>
    </div>
    <div data-question-id="q1">question</div>
    <div data-question-id="q2" hidden>hidden question</div>
    <div data-approval-key="a1">approval</div>`
  assert.equal(findCardTarget(cardTargetOf({ kind: 'answer', questionId: 'q1' }), doc).getAttribute('data-question-id'), 'q1')
  assert.equal(findCardTarget(cardTargetOf({ kind: 'answer', questionId: 'q2' }), doc), undefined, 'a hidden copy is skipped')
  assert.equal(findCardTarget(cardTargetOf({ kind: 'approval' }), doc).getAttribute('data-approval-key'), 'a1')
  assert.equal(findCardTarget(cardTargetOf({ kind: 'blocked', work: 'w1' }), doc).textContent, 'second')
})

test('jumping scrolls the card up, opens its fold and flashes it', async () => {
  const doc = page()
  const card = doc.createElement('div')
  card.setAttribute('data-question-id', 'q1')
  const detail = doc.createElement('div')
  detail.setAttribute('data-card-collapsed', 'true')
  detail.textContent = 'a long question'
  const toggle = doc.createElement('button')
  toggle.setAttribute('data-card-toggle', '')
  toggle.setAttribute('aria-expanded', 'false')
  toggle.addEventListener('click', () => toggle.setAttribute('aria-expanded', 'true'))
  card.append(detail, toggle)
  doc.body.append(card)
  const scrolled = []
  const inner = []
  card.scrollIntoView = options => scrolled.push(options.block)
  toggle.scrollIntoView = options => inner.push(['toggle', options.block])
  detail.scrollIntoView = options => inner.push(['detail', options.block])

  const result = jumpToCard(cardTargetOf({ kind: 'answer', questionId: 'q1' }), doc, { flashMs: 5 })
  assert.equal(result.element, card)
  assert.equal(result.expanded, true)
  assert.deepEqual(scrolled, ['center'], 'the card is brought into view')
  assert.deepEqual(inner, [['toggle', 'nearest'], ['detail', 'nearest']], 'the control and the opened text stay in the card\'s own scroll view')
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'the card\'s own fold is opened')
  assert.equal(detail.getAttribute('data-card-collapsed'), 'false')
  assert.equal(card.getAttribute('data-card-expanded'), 'true')
  assert.ok(card.classList.contains('bt-card-flash'))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(card.classList.contains('bt-card-flash'), false, 'the hint is short')
})

test('an approval card is scrolled and marked expanded, and a work row is only scrolled', () => {
  const doc = page()
  const approval = doc.createElement('div')
  approval.setAttribute('data-approval-key', 'a1')
  const scrolled = []
  approval.scrollIntoView = () => scrolled.push('approval')
  doc.body.append(approval)
  const approved = jumpToCard(cardTargetOf({ kind: 'approval' }), doc, { flashMs: 0 })
  assert.equal(approved.element, approval)
  assert.equal(approval.getAttribute('data-card-expanded'), 'true')

  doc.body.innerHTML += '<div data-chat-flow><div data-chat-flow-key="k1">one</div><div data-chat-flow-key="k2">two</div></div>'
  const flow = doc.querySelector('[data-chat-flow]')
  const last = flow.lastElementChild
  last.scrollIntoView = () => scrolled.push('last')
  const work = jumpToCard(cardTargetOf({ kind: 'blocked', work: 'w1' }), doc, { flashMs: 0 })
  assert.equal(work.element, last)
  assert.equal(work.expanded, false)
  assert.equal(last.getAttribute('data-card-expanded'), null)
  assert.deepEqual(scrolled, ['approval', 'last'])
})

test('a focus request names the conversation and a fresh token', () => {
  cardFocus.set(null)
  const request = focusCard({ kind: 'blocked', work: 'w1', sessionId: 'b' }, 1234)
  assert.equal(request.sessionId, 'b')
  assert.equal(request.key, 'w1')
  assert.match(request.token, /^1234:/)
  assert.equal(cardFocus.getSnapshot().token, request.token)
  const again = focusCard({ kind: 'blocked', work: 'w1', sessionId: 'b' }, 1235)
  assert.notEqual(again.token, request.token, 'asking again asks again')
})
