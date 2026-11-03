import test from 'node:test'
import assert from 'node:assert/strict'
import { opensReply, stepReasoning, thinkingStep } from '../src/client/turn-reasoning.js'

const step = (n, blocks, status = 'settled') => ({ turn: 1, step: n, status, blocks })
const think = text => ({ kind: 'reasoning', text })
const tool = { kind: 'tool-call', name: 'read' }

test('a step shows its own reasoning, not the Turn collected into one block', () => {
  const steps = [step(1, [think('Reasoning 1'), tool]), step(2, [think('Reasoning 2'), tool]), step(3, [{ kind: 'text', text: 'Done' }])]
  assert.deepEqual(steps.map(stepReasoning), ['Reasoning 1', 'Reasoning 2', ''])
})

test('a step without reasoning shows none', () => {
  assert.equal(stepReasoning(step(1, [{ kind: 'text', text: 'Done' }])), '')
  assert.equal(stepReasoning(step(1, [tool])), '')
})

test('a `<signature>` block at the head of reasoning never shows', () => {
  // A signature alone leaves nothing to show, like DSH's hidden reasoning row.
  assert.equal(stepReasoning(step(1, [think('<signature>abc123</signature>')])), '')
  assert.equal(stepReasoning(step(1, [think('<signature>abc123</signature>\n\nReal thought')])), 'Real thought')
  assert.equal(stepReasoning(step(1, [think('<signature>abc123</signature>\r\n\r\nReal thought')])), 'Real thought')
  // A stream that has only reached inside the tag shows nothing yet.
  assert.equal(stepReasoning(step(1, [think('<sign')])), '')
  assert.equal(stepReasoning(step(1, [think('<signature>abc123')])), '')
  // Text that only looks like it stays untouched.
  assert.equal(stepReasoning(step(1, [think('A <signature> mention')])), 'A <signature> mention')
})

test('the live step is the one still thinking', () => {
  const steps = [step(1, [think('A'), tool]), step(2, [think('B')], 'running')]
  assert.equal(thinkingStep(steps), steps[1])
  // Reasoning that moved on to its reply no longer ticks.
  steps[1].blocks.push({ kind: 'text', text: 'Reply' })
  assert.equal(thinkingStep(steps), undefined)
  // A running step without reasoning yet is not thinking either.
  assert.equal(thinkingStep([step(3, [tool], 'running')]), undefined)
  assert.equal(thinkingStep(steps.slice(0, 1)), undefined)
})

test('a reply opens on its first text or its first reasoning, whichever comes first', () => {
  const opener = steps => steps.findIndex(current => opensReply(steps, current))
  // A word before the tools opens the reply, ahead of a later reasoning step.
  assert.equal(opener([step(1, [{ kind: 'text', text: 'Looking' }, tool]), step(2, [think('B'), tool]), step(3, [{ kind: 'text', text: 'Done' }])]), 0)
  // A reasoning-first step opens it.
  assert.equal(opener([step(1, [think('B'), tool]), step(2, [tool]), step(3, [{ kind: 'text', text: 'Done' }])]), 0)
  // Tools alone open nothing; the step that answers does.
  assert.equal(opener([step(1, [tool]), step(2, [tool]), step(3, [{ kind: 'text', text: 'Done' }])]), 2)
  assert.equal(opener([step(1, [tool])]), -1)
})

test("with the reasoning hidden, only a step's own text opens the reply", () => {
  const opener = steps => steps.findIndex(current => opensReply(steps, current, false))
  assert.equal(opener([step(1, [think('B'), tool]), step(2, [tool]), step(3, [{ kind: 'text', text: 'Done' }])]), 2)
  assert.equal(opener([step(1, [{ kind: 'text', text: 'Looking' }, tool]), step(2, [think('B'), tool]), step(3, [think('C'), { kind: 'text', text: 'Done' }])]), 0)
  assert.equal(opener([step(1, [think('B'), tool])]), -1)
})
