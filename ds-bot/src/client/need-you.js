// The "needs you" block at the top of the sidebar: what waits for the user right now,
// one row each, and nothing when nothing does. The whole list is handled in one place:
// every answer field opens at once or one at a time, a work can be ignored, and a
// second click clears the works the user does not want to act on. An open question
// shows its answers as buttons plus a field for an answer of the user's own, so it is
// answered here without opening the chat; any row opens the Bot it belongs to, and a
// blocked or reviewed work carries a field to answer the Bot that is stuck. The same
// block answers the other two questions: whether the system is well (shown only when it
// is not) and what happened to one piece of work (its timeline, opened from its row).
import { createElement as h, useState } from 'react'
import { language } from './i18n.js'
import { elapsedLabel } from './text.js'

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

// The health question, in one line: what is wrong right now, and nothing when the team
// is well. A count of zero is the quiet case, so it is left out.
export function healthLineOf(health) {
  if (health === null || health === undefined) return undefined
  const parts = []
  if (health.deliveryFailures > 0) parts.push(zh() ? `${health.deliveryFailures} 次投递失败` : `${health.deliveryFailures} failed ${health.deliveryFailures === 1 ? 'delivery' : 'deliveries'}`)
  if (health.answerFailures > 0) parts.push(zh() ? `${health.answerFailures} 次回答失败` : `${health.answerFailures} failed ${health.answerFailures === 1 ? 'answer' : 'answers'}`)
  if (health.stalled > 0) parts.push(zh() ? `${health.stalled} 件停滞` : `${health.stalled} stalled`)
  return parts.length === 0 ? undefined : parts.join(' · ')
}

// The history question, as the lines of one work's timeline: the time is counted from
// the moment it was opened, so a row reads "2m 10s blocked: needs a key".
const EVENT_NAMES = {
  created: ['创建', 'Created'],
  proposed: ['提议', 'Proposed'],
  progress: ['进行中', 'Progress'],
  ready: ['可验收', 'Ready'],
  blocked: ['受阻', 'Blocked'],
  failed: ['失败', 'Failed'],
  dropped: ['无需处理', 'Dropped'],
  stalled: ['停滞', 'Stalled'],
  closed: ['结束', 'Ended'],
}
export function historyLines(item) {
  const history = Array.isArray(item?.history) ? item.history : []
  if (history.length === 0) return []
  const start = history[0].at ?? 0
  return history.map((event) => {
    const name = EVENT_NAMES[event.event]?.[zh() ? 0 : 1] ?? String(event.event)
    const meaning = event.summary ?? event.text ?? (event.final === undefined ? '' : (EVENT_NAMES[event.final]?.[zh() ? 0 : 1] ?? event.final))
    return {
      at: event.at,
      time: elapsedLabel((event.at ?? start) - start),
      text: meaning === '' ? name : `${name}: ${meaning}`,
    }
  })
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
  return h('div', { className: 'bt-needs-answers bt-needs-answer-box' },
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

// A blocked Bot is not answered by a button: it needs a word from the user to go on,
// so its row carries a field for one and a retry, beside opening its chat.
function ReplyBox({ item, onSend }) {
  const [text, setText] = useState('')
  const send = (said) => {
    if (item.sessionId === undefined) return
    onSend?.(item.sessionId, said)
  }
  const submit = () => {
    const said = text.trim()
    if (said === '') return
    send(said)
    setText('')
  }
  return h('div', { className: 'bt-needs-answers' },
    h('button', {
      type: 'button',
      className: 'bt-needs-answer',
      onClick: (event) => { event.stopPropagation(); send(item.kind === 'review' ? 'Looks good, go on.' : 'Go on: this is handled, retry it.') },
    }, zh() ? '继续' : 'Go on'),
    h('span', { className: 'bt-needs-free' },
      h('input', {
        type: 'text',
        value: text,
        placeholder: zh() ? '回它一句…' : 'Say something…',
        'aria-label': zh() ? '回复这个 Bot' : 'Reply to this Bot',
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

export function NeedsYou({ items: all_items, health, onOpen, onAnswer, onSend, onApprove, onIgnore }) {
  const items = Array.isArray(all_items) ? all_items : []
  const [open, setOpen] = useState({}) // per item: is its answer field shown
  const [all, setAll] = useState(false) // every answer field at once
  const [timeline, setTimeline] = useState({}) // per work: is its history shown
  const trouble = healthLineOf(health)
  if (items.length === 0 && trouble === undefined) return null
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
    trouble === undefined ? null : h('div', { className: 'bt-needs-health', role: 'status', title: zh() ? '最近一小时' : 'In the last hour' }, trouble),
    h('div', { className: 'bt-needs-head' },
      h('span', { className: 'bt-needs-title' }, zh() ? '需要你' : 'Needs you'),
      h('span', { className: 'bt-needs-count' }, String(items.length)),
      tools.length === 0 ? null : h('span', { className: 'bt-needs-tools' }, tools)),
    h('ul', { className: 'bt-needs-list bt-needs-scroll' },
      items.map((item, index) => {
        const key = itemKey(item)
        const shown = all || open[key] === true
        const shownHistory = timeline[key] === true
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
            }, zh() ? '答' : 'Answer') : [
              ...(item.kind === 'proposed' ? [h('button', {
                key: 'approve',
                type: 'button',
                className: 'bt-needs-tool bt-needs-approve',
                title: zh() ? '批准就等于替它发出这条请求' : 'Approving sends this request for it',
                onClick: () => onApprove?.(item.work),
              }, zh() ? '批准' : 'Approve')] : []),
              h('button', {
                key: 'history',
                type: 'button',
                className: 'bt-needs-tool bt-needs-hist',
                'aria-expanded': shownHistory,
                title: zh() ? '这件活从创建到结束' : 'This work, from start to end',
                onClick: () => setTimeline(prev => ({ ...prev, [key]: !prev[key] })),
              }, zh() ? '历史' : 'History'),
              h('button', {
                key: 'ignore',
                type: 'button',
                className: 'bt-needs-tool bt-needs-ignore',
                title: zh() ? '忽略这一条' : 'Ignore this one',
                'aria-label': zh() ? '忽略这一条' : 'Ignore this one',
                onClick: () => dismiss([key]),
              }, '×'),
            ]),
          item.kind === 'answer' && shown ? h(AnswerBox, { key: `answers-${index}`, item, onAnswer }) : null,
          item.kind === 'blocked' || item.kind === 'review' ? h(ReplyBox, { key: `reply-${index}`, item, onSend }) : null,
          item.kind !== 'answer' && shownHistory ? h('ol', { className: 'bt-needs-history', 'aria-label': zh() ? '这件活的历史' : 'History of this work' },
            historyLines(item).map((line, at) => h('li', { key: at },
              h('span', { className: 'bt-needs-hist-time' }, line.time),
              h('span', { className: 'bt-needs-hist-text' }, line.text)))) : null)
      })))
}
