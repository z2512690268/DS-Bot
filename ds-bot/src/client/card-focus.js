// The card a "needs you" row points at, and how to bring it into view.
//
// A row in the sidebar opens its conversation; a double-click (or Enter on the focused
// row) goes further: it opens the conversation, scrolls the card to the middle, expands
// what the card keeps folded, and gives it a short flash. A row for a work that is
// blocked, ready or proposed has no card of its own, so its target is the newest row of
// the conversation; a question targets its question card; an approval targets DSH's own
// approval card.
import { createSource } from './sources.js'

export const CARD_FLASH = 'bt-card-flash'
export const CARD_FLASH_MS = 1500

const attr = value => String(value ?? '').replace(/["\\]/g, '\\$&')

export function cardTargetOf(item) {
  if (item.kind === 'answer') {
    const id = String(item.questionId ?? '')
    return { selector: `[data-question-id="${attr(id)}"]`, key: `question:${id}`, expand: true }
  }
  if (item.kind === 'approval') return { selector: '[data-approval-key]', key: item.key ?? 'approval', expand: true }
  return { selector: '[data-chat-flow] > [data-chat-flow-key]', key: item.work ?? item.key ?? item.kind, expand: false, last: true }
}

// The request the conversation view watches: one at a time, with a token so asking for
// the same card twice still brings it back into view.
export const cardFocus = createSource(null)

export function focusCard(item, at = Date.now()) {
  const target = cardTargetOf(item)
  const request = {
    ...target,
    sessionId: item.sessionId ?? item.botId,
    token: `${at}:${Math.random().toString(36).slice(2)}`,
    at,
  }
  cardFocus.set(request)
  return request
}

// The element to bring up. A card hidden by a dock whose copy the transcript draws is
// skipped; a work row points at the newest flow row.
export function findCardTarget(target, root = globalThis.document) {
  if (root === undefined || target?.selector === undefined) return undefined
  const matches = [...root.querySelectorAll(target.selector)]
    .filter(element => element.hidden !== true && element.getAttribute('aria-hidden') !== 'true')
  return target.last === true ? matches.at(-1) : matches[0]
}

// Expand the card's own fold. `data-card-toggle` is a button whose
// `aria-expanded="false"` means folded; `data-card-collapsed` is a CSS-only fold.
// Returns whether something was opened, and leaves `data-card-expanded` for CSS.
export function revealCard(element, { flashMs = CARD_FLASH_MS, flash = true, expand = true } = {}) {
  if (element === undefined) return { expanded: false }
  let expanded = false
  if (expand) {
    for (const toggle of element.querySelectorAll('[data-card-toggle][aria-expanded="false"]')) {
      // The card may scroll inside itself (a long question is capped): bring the
      // control into view before pressing it, and the opened text after.
      toggle.scrollIntoView?.({ block: 'nearest' })
      toggle.click?.()
      expanded = true
    }
    for (const node of element.querySelectorAll('[data-card-collapsed]')) {
      if (node.getAttribute('data-card-collapsed') === 'false') continue
      node.setAttribute('data-card-collapsed', 'false')
      node.scrollIntoView?.({ block: 'nearest' })
      expanded = true
    }
    element.setAttribute('data-card-expanded', 'true')
    expanded = true
  }
  element.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  if (flash) {
    element.classList.remove(CARD_FLASH)
    void element.offsetWidth
    element.classList.add(CARD_FLASH)
    if (flashMs > 0) setTimeout(() => element.classList.remove(CARD_FLASH), flashMs)
  }
  return { expanded }
}

// Find and reveal in one step; undefined while the card is not in the DOM yet.
export function jumpToCard(target, root = globalThis.document, options = {}) {
  const element = findCardTarget(target, root)
  if (element === undefined) return undefined
  return { element, ...revealCard(element, { expand: target.expand !== false, ...options }) }
}
