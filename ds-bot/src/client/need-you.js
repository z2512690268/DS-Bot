// The "needs you" block at the top of the sidebar: what waits for the user right now,
// one row each, and nothing when nothing does. An open question shows its answers as
// buttons plus a field for an answer of the user's own, so it is answered here without
// opening the chat; any row opens the Bot it belongs to.
import { createElement as h, useState } from 'react'
import { language } from './i18n.js'

// Names chosen here, not through t(): the block must read in the interface language
// even when the host's own dictionary does not hold these lines.
const zh = () => language().startsWith('zh')
const kindOf = (kind) => {
  if (kind === 'answer') return zh() ? '等你回答' : 'Waits for your answer'
  if (kind === 'blocked') return zh() ? '受阻' : 'Blocked'
  return zh() ? '待验收' : 'Ready to review'
}

const lineOf = (item) => {
  if (item.kind === 'answer') return item.question ?? ''
  return item.summary ?? item.detail ?? ''
}

// The answers of one question: the choices it offers, and always a field of the user's
// own, because a card whose options do not cover the answer still has to be answerable.
function AnswerBox({ item, onAnswer }) {
  const [text, setText] = useState('')
  const options = Array.isArray(item.options) ? item.options.slice(0, 3) : []
  const send = (answer) => {
    if (item.sessionId === undefined || item.questionId === undefined) return
    onAnswer?.(item.sessionId, item.questionId, answer)
  }
  const submit = () => {
    const custom = text.trim()
    if (custom === '') return
    send({ selected: [], custom })
    setText('')
  }
  return h('div', { className: 'bt-needs-answers' },
    options.map(option => h('button', {
      key: option.label,
      type: 'button',
      className: 'bt-needs-answer',
      onClick: (event) => { event.stopPropagation(); send({ selected: [option.label], custom: '' }) },
    }, option.label)),
    item.allowCustom === false ? null : h('span', { className: 'bt-needs-free' },
      h('input', {
        type: 'text',
        value: text,
        placeholder: zh() ? '自己写…' : 'Write your own…',
        'aria-label': zh() ? '自己写一个回答' : 'Write your own answer',
        onChange: event => setText(event.target.value),
        onKeyDown: (event) => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          event.stopPropagation()
          submit()
        },
        onClick: event => event.stopPropagation(),
      }),
      h('button', {
        type: 'button',
        className: 'bt-needs-send',
        disabled: text.trim() === '',
        onClick: (event) => { event.stopPropagation(); submit() },
      }, zh() ? '发送' : 'Send')))
}

export function NeedsYou({ items, onOpen, onAnswer }) {
  if (!Array.isArray(items) || items.length === 0) return null
  const shown = items.slice(0, 4)
  const more = items.length - shown.length
  return h('section', { className: 'bt-needs', 'aria-label': zh() ? '需要你' : 'Needs you' },
    h('div', { className: 'bt-needs-head' },
      h('span', { className: 'bt-needs-title' }, zh() ? '需要你' : 'Needs you'),
      h('span', { className: 'bt-needs-count' }, String(items.length))),
    h('ul', { className: 'bt-needs-list' },
      shown.map((item, index) => h('li', { key: `${item.kind}-${item.work ?? item.questionId ?? index}` },
        h('button', {
          type: 'button',
          className: 'bt-needs-row',
          'data-kind': item.kind,
          title: [item.bot, lineOf(item)].filter(Boolean).join(' · '),
          onClick: () => { if (item.botId !== undefined) onOpen?.(item.botId) },
        },
          h('span', { className: 'bt-needs-mark', 'aria-hidden': true }),
          h('span', { className: 'bt-needs-kind' }, kindOf(item.kind)),
          h('span', { className: 'bt-needs-text' }, lineOf(item)),
          item.bot === undefined ? null : h('span', { className: 'bt-needs-bot' }, item.bot)),
        item.kind === 'answer' ? h(AnswerBox, { key: 'answers', item, onAnswer }) : null))),
    more > 0 ? h('div', { className: 'bt-needs-more' }, zh() ? `还有 ${more} 条` : `${more} more`) : null)
}
