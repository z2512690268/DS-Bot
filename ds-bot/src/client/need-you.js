// The "needs you" block at the top of the sidebar: what waits for the user right now,
// one row each, and nothing when nothing does. The list comes from the host, which
// derives it from open question cards and work that came back blocked or ready.
import { createElement as h } from 'react'
import { t } from './i18n.js'

const KIND = {
  answer: 'Waits for your answer',
  blocked: 'Blocked',
  review: 'Ready to review',
}

const lineOf = (item) => {
  if (item.kind === 'answer') return item.question ?? ''
  return item.summary ?? item.detail ?? ''
}

export function NeedsYou({ items, onOpen }) {
  if (!Array.isArray(items) || items.length === 0) return null
  const shown = items.slice(0, 5)
  const more = items.length - shown.length
  return h('section', { className: 'bt-needs', 'aria-label': t('Needs you') },
    h('div', { className: 'bt-needs-head' },
      h('span', { className: 'bt-needs-title' }, t('Needs you')),
      h('span', { className: 'bt-needs-count' }, String(items.length))),
    h('ul', { className: 'bt-needs-list' },
      shown.map((item, index) => h('li', { key: `${item.kind}-${item.work ?? item.botId ?? index}` },
        h('button', {
          type: 'button',
          className: 'bt-needs-row',
          'data-kind': item.kind,
          title: [item.bot, lineOf(item)].filter(Boolean).join(' · '),
          onClick: () => { if (item.botId !== undefined) onOpen?.(item.botId) },
        },
          h('span', { className: 'bt-needs-mark', 'aria-hidden': true }),
          h('span', { className: 'bt-needs-kind' }, t(KIND[item.kind] ?? item.kind)),
          h('span', { className: 'bt-needs-text' }, lineOf(item)),
          item.bot === undefined ? null : h('span', { className: 'bt-needs-bot' }, item.bot))))),
    more > 0 ? h('div', { className: 'bt-needs-more' }, t('{count} more', { count: more })) : null)
}
