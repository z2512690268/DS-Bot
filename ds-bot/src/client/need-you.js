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
  if (kind === 'approval') return zh() ? '等你批准' : 'Waiting for approval'
  return zh() ? '待验收' : 'Ready to review'
}

const lineOf = (item) => {
  if (item.kind === 'answer') return item.question ?? ''
  if (item.kind === 'approval' && (item.approvals?.length ?? 0) > 1) {
    return zh() ? `${item.summary} · 还有 ${item.approvals.length - 1} 个` : `${item.summary} · ${item.approvals.length - 1} more`
  }
  return item.summary ?? item.detail ?? ''
}

const itemKey = (item) => {
  if (item.key !== undefined) return item.key
  if (item.kind === 'answer') return `answer:${item.questionId}`
  if (item.kind === 'approval') return `approval:${item.sessionId}`
  return `${item.kind}:${item.work}`
}

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

// A length of time as a short phrase: 12s, 4m, 1h 6m.
export function shortDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hour = Math.floor(min / 60)
  const rest = min % 60
  return rest === 0 ? `${hour}h` : `${hour}h ${rest}m`
}

// How the day went, in one line for the same block: what finished, how long the typical
// one took, what is stalled, and what failed. Nothing to say on a quiet day, and no
// dashboard: one sentence, in the same voice as the health line.
export function statsLineOf(stats) {
  const day = stats?.day
  if (day === undefined || day === null) return undefined
  const closed = day.closed ?? 0
  const stalled = day.stalled ?? 0
  const failures = (day.deliveryFailures ?? 0) + (day.answerFailures ?? 0)
  if (closed === 0 && stalled === 0 && failures === 0) return undefined
  const parts = []
  if (closed > 0) parts.push(zh() ? `关闭 ${closed} 件` : `${closed} done`)
  if (day.medianMs !== undefined) parts.push(zh() ? `中位 ${shortDuration(day.medianMs)}` : `median ${shortDuration(day.medianMs)}`)
  if (stalled > 0) parts.push(zh() ? `停滞 ${stalled}` : `${stalled} stalled`)
  if (failures > 0) parts.push(zh() ? `失败 ${failures}` : `${failures} failed`)
  return `${zh() ? '近 24 小时' : 'Last 24h'}: ${parts.join(' · ')}`
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
  const send = (said) => onSend?.(said)
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

// The rows the block shows: what the host listed, minus what this window just handled.
// The rule is the host's — a row hidden at `at` comes back once its work moves on, so
// a new report or a new stall after the reply is news again.
export function visibleItems(items, hidden) {
  const list = Array.isArray(items) ? items : []
  return list.filter((item) => {
    const at = hidden?.[itemKey(item)]
    return at === undefined || at < (item.since ?? 0)
  })
}

// What a reply from a blocked row does: the row goes at once, the message goes out, and
// only after that is the item dismissed on the host. Any failure brings the row back, so
// a row that stayed away was really handled.
export async function replyAndDismiss({ item, said, hidden = {}, at = Date.now(), onSend, onIgnore }) {
  const key = itemKey(item)
  const optimistic = { ...hidden, [key]: at }
  try {
    await onSend?.(item.sessionId, said)
    await onIgnore?.([key])
    return { ok: true, hidden: optimistic }
  } catch (error) {
    return { ok: false, error, hidden }
  }
}

export function NeedsYou({ items: all_items, health, stats, onOpen, onAnswer, onSend, onApprove, onApproval, onIgnore, onError }) {
  const items = Array.isArray(all_items) ? all_items : []
  const [open, setOpen] = useState({}) // per item: is its answer field shown
  const [all, setAll] = useState(false) // every answer field at once
  const [timeline, setTimeline] = useState({}) // per work: is its history shown
  const [hidden, setHidden] = useState({}) // item key: when this window took it away
  const [answered, setAnswered] = useState({}) // approval id: the answer this window sent
  const [openApprovals, setOpenApprovals] = useState({}) // item key: are its folded approvals shown
  const trouble = healthLineOf(health)
  const summary = statsLineOf(stats)
  // An approval answered here leaves at once; the host drops the request from the next
  // poll. A failed answer puts it back and tells the user, like every other row.
  const rows = visibleItems(items, hidden)
    .map(item => (item.kind === 'approval'
      ? { ...item, approvals: (Array.isArray(item.approvals) ? item.approvals : []).filter(one => answered[one.id] === undefined) }
      : item))
    .filter(item => item.kind !== 'approval' || item.approvals.length > 0)
  if (rows.length === 0 && trouble === undefined && summary === undefined) return null
  const answers = rows.filter(item => item.kind === 'answer')
  const works = rows.filter(item => item.kind !== 'answer' && item.kind !== 'approval')
  const toggle = key => setOpen(prev => ({ ...prev, [key]: !prev[key] }))
  const answerApproval = (approval, choice) => {
    setAnswered(prev => ({ ...prev, [approval.id]: choice }))
    void Promise.resolve(onApproval?.(approval.id, choice)).catch((error) => {
      setAnswered((prev) => {
        const next = { ...prev }
        delete next[approval.id]
        return next
      })
      onError?.(error, 'approval')
    })
  }
  // A reply takes its row away at once; the host then confirms the dismissal. A message
  // or dismissal that failed gives the row back and tells the user, so one that stayed
  // away is one that was handled.
  const sendReply = (item, said) => {
    const key = itemKey(item)
    const at = Date.now()
    setHidden(prev => ({ ...prev, [key]: at }))
    void Promise.resolve(replyAndDismiss({ item, said, hidden, at, onSend, onIgnore }))
      .then((result) => {
        setHidden(result.hidden)
        if (!result.ok) onError?.(result.error, 'needs-reply')
      })
      .catch((error) => {
        setHidden((prev) => {
          const next = { ...prev }
          delete next[key]
          return next
        })
        onError?.(error, 'needs-reply')
      })
  }
  const dismiss = (keys) => {
    const list = keys.filter(key => typeof key === 'string' && key !== '')
    if (list.length === 0) return
    const at = Date.now()
    setHidden(prev => ({ ...prev, ...Object.fromEntries(list.map(key => [key, at])) }))
    void Promise.resolve(onIgnore?.(list)).catch((error) => {
      setHidden((prev) => {
        const next = { ...prev }
        for (const key of list) delete next[key]
        return next
      })
      onError?.(error, 'needs-dismiss')
    })
  }
  // The two buttons of one approval, used both on a single row and in a folded list.
  const approvalButtons = (approval) => [
    h('button', {
      key: 'allow',
      type: 'button',
      className: 'bt-needs-answer',
      onClick: (event) => { event.stopPropagation(); answerApproval(approval, 'allow') },
    }, zh() ? '允许一次' : 'Allow once'),
    h('button', {
      key: 'reject',
      type: 'button',
      className: 'bt-needs-tool bt-needs-reject',
      onClick: (event) => { event.stopPropagation(); answerApproval(approval, 'reject') },
    }, zh() ? '拒绝' : 'Reject'),
  ]
  // What the policy could not decide waits under its row: the request read in full, and
  // why the team could not settle it itself. Several requests open at once are folded
  // into one row and opened one by one.
  const approvalDetail = (item, index) => {
    const approvals = item.approvals
    if (approvals.length > 1) {
      if (openApprovals[itemKey(item)] !== true) return null
      return h('ul', { key: `approvals-${index}`, className: 'bt-needs-approvals', 'aria-label': zh() ? '等你逐条批准' : 'Approvals waiting for you' },
        approvals.map(one => h('li', { key: one.id, className: 'bt-needs-approval' },
          h('span', { className: 'bt-needs-approval-tool' }, one.tool || (zh() ? '某个工具' : 'a tool')),
          one.reason === '' ? null : h('span', { className: 'bt-needs-approval-reason' }, one.reason),
          one.unsure === undefined ? null : h('span', { className: 'bt-needs-unsure' }, `${zh() ? '我拿不准' : 'Not sure'}: ${one.unsure}`),
          approvalButtons(one))))
    }
    const one = approvals[0]
    return h('div', { key: `approval-${index}`, className: 'bt-needs-approval-detail' },
      one.reason === '' ? null : h('span', { className: 'bt-needs-approval-reason' }, one.reason),
      h('span', { className: 'bt-needs-unsure' }, `${zh() ? '我拿不准' : 'Not sure'}: ${one.unsure ?? (zh() ? '需要你决定' : 'needs your decision')}`))
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
    summary === undefined ? null : h('div', { className: 'bt-needs-stats', title: zh() ? '最近 24 小时' : 'In the last 24 hours' }, summary),
    h('div', { className: 'bt-needs-head' },
      h('span', { className: 'bt-needs-title' }, zh() ? '需要你' : 'Needs you'),
      h('span', { className: 'bt-needs-count' }, String(rows.length)),
      tools.length === 0 ? null : h('span', { className: 'bt-needs-tools' }, tools)),
    h('ul', { className: 'bt-needs-list bt-needs-scroll' },
      rows.map((item, index) => {
        const key = itemKey(item)
        const shown = all || open[key] === true
        const shownHistory = timeline[key] === true
        const approvals = item.kind === 'approval' ? item.approvals : []
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
            }, zh() ? '答' : 'Answer') : item.kind === 'approval' ? (approvals.length > 1 ? [
              h('button', {
                key: 'approval-open',
                type: 'button',
                className: 'bt-needs-tool bt-needs-open',
                'aria-expanded': openApprovals[key] === true,
                onClick: () => setOpenApprovals(prev => ({ ...prev, [key]: !prev[key] })),
              }, zh() ? `逐个处理 ${approvals.length}` : `Answer ${approvals.length}`),
            ] : approvalButtons(approvals[0])) : [
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
          item.kind === 'blocked' || item.kind === 'review' ? h(ReplyBox, { key: `reply-${index}`, item, onSend: said => sendReply(item, said) }) : null,
          item.kind === 'approval' ? approvalDetail(item, index) : null,
          item.kind !== 'answer' && item.kind !== 'approval' && shownHistory ? h('ol', { className: 'bt-needs-history', 'aria-label': zh() ? '这件活的历史' : 'History of this work' },
            historyLines(item).map((line, at) => h('li', { key: at },
              h('span', { className: 'bt-needs-hist-time' }, line.time),
              h('span', { className: 'bt-needs-hist-text' }, line.text)))) : null)
      })))
}
