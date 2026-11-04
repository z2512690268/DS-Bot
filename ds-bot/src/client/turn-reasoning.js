// One step's reasoning, drawn as its own block above that step's content — the shape
// DSH's own chat gives it, so thinking and tool lines stay apart.
export function stepReasoning(step) {
  if (step?.blocks === undefined) return ''
  return step.blocks
    .filter(block => block.kind === 'reasoning')
    .map(block => visibleReasoning(block.text))
    .join('\n')
    .trim()
}

// The Turn's latest reasoning before `current`: the answer step often has no reasoning
// of its own, and the reasoning that led to it is what a waiting reader wants to see.
export function previousReasoning(steps, current) {
  const earlier = steps.filter(step => step !== current && (step.step === undefined || current.step === undefined || step.step < current.step))
  for (let index = earlier.length - 1; index >= 0; index -= 1) {
    const text = stepReasoning(earlier[index])
    if (text !== '') return text
  }
  return ''
}

// Whether `current` opens the Turn's reply in the chat: the first step that shows
// anything — reply text, or its own reasoning while thinking is shown.
export function opensReply(steps, current, withReasoning = true) {
  const members = steps.length ? steps : [current]
  const opener = members.find(step => texts(step).length > 0 || (withReasoning && stepReasoning(step) !== ''))
  return opener?.step === current.step
}

// A step still streaming reasoning with no reply text yet is thinking: the row
// counts its clock from `step.time`, the time its first visible chunk arrived.
export const thinkingStep = steps => steps.find(thinkingLive)

const thinkingLive = step => step.status === 'running' && texts(step).length === 0 && step.blocks.some(block => block.kind === 'reasoning')

const texts = step => step.blocks.filter(block => block.kind === 'text' && block.text.trim() !== '')

// Reasoning can open with a `<signature>` block meant for the model, not the
// reader; DSH's chat hides it since 0.2.1-rc.5 and the Bot chat strips it the
// same way, keeping the raw record in the session.
const visibleReasoning = text => {
  if (text[0] !== '<') return text
  if ('<signature>'.startsWith(text)) return ''
  if (!text.startsWith('<signature>')) return text
  const end = text.indexOf('</signature>')
  return end === -1 ? '' : text.slice(end + '</signature>'.length).replace(/^(\r?\n)+/, '')
}
