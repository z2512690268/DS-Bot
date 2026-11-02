// The "needs you" block at the top of the sidebar: what waits for the user right now,
// one row each, and nothing when nothing does. The whole list is handled in one place:
// every answer field opens at once or one at a time, a work can be ignored, and a
// second click clears the works the user does not want to act on. An open question
// shows its answers as buttons plus a field for an answer of the user's own, so it is
// answered here without opening the chat; any row opens the Bot it belongs to.
import { createElement as h, useState } from 'react'
import { language } from './i18n.js'

// Names chosen here, not through t(): the block must read in the interface language
// even when the host's own dictionary does not hold these lines.
const zh = () => language().startsWith('zh')
const kindOf = (kind) => {
  if (kind === 'answer') return zh() ? '等你回答' : 'Waits for your answer'
  if (kind === 'blocked') return zh() ? '受阻' : 'Blocked'
  if (kind === 'proposed') return zh() ? '我本来会做' : 'I would have done'
  return zh() ? '待验收' : 'Ready to review'
}

const lineOf = (item) => {
  if (item.kind === 'answer') return item.question ?? ''
  return item.summary ?? item.detail ?? ''
}

const itemKey = item => item.key ?? (item.kind === 'answer' ? `answer:${item.questionId}` : `${item.kind}:${item.work}`)

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

export function NeedsYou({ items, onOpen, onAnswer, onIgnore }) {
  const [open, setOpen] = useState({}) // per item: is its answer field shown
  const [all, setAll] = useState(false) // every answer field at once
  if (!Array.isArray(items) || items.length === 0) return null
  const answers = items.filter(item => item.kind === 'answer')
  const works = items.filter(item => item.kind !== 'answer')
  const toggle = key => setOpen(prev => ({ ...prev, [key]: !prev[key] }))
  const dismiss = (keys) => {
    const list = keys.filter(key => typeof key === 'string' && key !== '')
    if (list.length > 0) onIgnore?.(list)
  }
  const tools = []
  if (answers.length > 0) {
    tools.push(h('button', {
      key: 'all',
      type: 'button',
      className: 'bt-needs-tool',
      'aria-expanded': all,
      onClick: () => setAll(value => !value),
    }, all ? (zh() ? '收起' : 'Collapse') : (zh() ? '全部展开' : 'Expand all')))
  }
  if (works.length > 0) {
    tools.push(h('button', {
      key: 'ignore',
      type: 'button',
      className: 'bt-needs-tool',
      title: zh() ? '从列表里清掉这些工作，不影响对话' : 'Clear these works from the list; the chats stay as they are',
      onClick: () => dismiss(works.map(itemKey)),
    }, zh() ? `全部忽略 ${works.length}` : `Ignore ${works.length}`))
  }
  return h('section', { className: 'bt-needs', 'aria-label': zh() ? '需要你' : 'Needs you' },
    h('div', { className: 'bt-needs-head' },
      h('span', { className: 'bt-needs-title' }, zh() ? '需要你' : 'Needs you'),
      h('span', { className: 'bt-needs-count' }, String(items.length)),
      tools.length === 0 ? null : h('span', { className: 'bt-needs-tools' }, tools)),
    h('ul', { className: 'bt-needs-list bt-needs-scroll' },
      items.map((item, index) => {
        const key = itemKey(item)
        const shown = all || open[key] === true
        return h('li', { className: 'bt-needs-entry', key },
          h('div', { className: 'bt-needs-line' },
            h('button', {
              type: 'button',
              className: 'bt-needs-row',
              'data-kind': item.kind,
              title: [item.bot, item.proposed === true && item.to !== undefined ? `→ ${item.to}` : undefined, lineOf(item)].filter(Boolean).join(' · '),
              onClick: () => { if (item.botId !== undefined) onOpen?.(item.botId) },
            },
              h('span', { className: 'bt-needs-mark', 'aria-hidden': true }),
              h('span', { className: 'bt-needs-kind' }, kindOf(item.kind)),
              h('span', { className: 'bt-needs-text' }, lineOf(item)),
              item.bot === undefined ? null : h('span', { className: 'bt-needs-bot' }, item.bot)),
            item.kind === 'answer' ? h('button', {
              type: 'button',
              className: 'bt-needs-tool bt-needs-open',
              'aria-expanded': shown,
              onClick: () => toggle(key),
            }, zh() ? '答' : 'Answer') : h('button', {
              type: 'button',
              className: 'bt-needs-tool bt-needs-ignore',
              title: zh() ? '忽略这一条' : 'Ignore this one',
              'aria-label': zh() ? '忽略这一条' : 'Ignore this one',
              onClick: () => dismiss([key]),
            }, '×')),
          item.kind === 'answer' && shown ? h(AnswerBox, { key: `answers-${index}`, item, onAnswer }) : null)
      })))
}
