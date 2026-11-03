// Approvals. A member's group Session is hidden, so DSH's approval card never shows
// there and the turn would wait forever: DS Bot answers those requests itself, from
// the group chat. A Bot's own chat first goes through the approval policy
// (approval-policy.js): routine work is decided at once and written to the audit, clearly
// out-of-bounds work is refused, and only what the policy cannot decide keeps DSH's card,
// waits in the "Needs you" list of the main chat, and is reported to the Bot that handed
// the work on if it waits too long.
import { randomUUID } from 'node:crypto'
import { decideApproval } from './approval-policy.js'
import { approvalTimeoutOf } from './work-state.js'

const OUTCOMES = { allow: 'allowed-once', reject: 'rejected' }
const AUDIT_MAX = 200
const SWEEP_MS = 30_000

export function install(rt) {
  const { ctx, state } = rt
  const timeout = approvalTimeoutOf(rt.config)
  /** @type {Map<string, {id:string, sessionId:string, botId:string, roomId?:string, tool:string, reason:string, detail:{text?:string, code?:string}, at:number, work?:string, from?:string, unsure?:string, rule?:string, timeoutReported?:boolean, reporting?:boolean, answer?:(outcome:string, by?:string)=>void}>} */
  const pending = new Map()

  const save = () => void rt.save().catch(() => {})
  const nameOf = id => rt.botOf(id)?.name
  const auditLog = () => (state.approvalLog ??= [])

  // One line per decision: who decided, by which rule or from which card, and when.
  function record(entry, outcome, { decidedBy, rule, ruleWhy, by, via }) {
    const log = auditLog()
    log.push({
      at: Date.now(),
      id: entry.id,
      botId: entry.botId,
      ...(entry.work === undefined ? {} : { work: entry.work }),
      tool: entry.tool,
      choice: outcome === 'allowed-once' ? 'allow' : 'reject',
      outcome,
      decidedBy,
      via,
      ...(rule === undefined ? {} : { rule }),
      ...(ruleWhy === undefined ? {} : { ruleWhy }),
      ...(entry.unsure === undefined ? {} : { unsure: entry.unsure }),
      ...(by === undefined ? {} : { by, ...(nameOf(by) === undefined ? {} : { byName: nameOf(by) }), onBehalfOfUser: true, note: `${nameOf(by) ?? 'A Main Bot'} answered this on the user's behalf` }),
      ...(entry.reason === '' ? {} : { reason: entry.reason.slice(0, 300) }),
    })
    if (log.length > AUDIT_MAX) log.splice(0, log.length - AUDIT_MAX)
    save()
  }

  // The roots the policy compares a request against: the team's data, its workspace and
  // the folder the Bot works in.
  const policyPaths = (botId) => ({
    dshHome: rt.dshHome,
    home: rt.home,
    workspace: rt.teamFolder?.(),
    workdir: rt.workDirOf?.({ botId }),
    userDshHome: process.env.DS_BOT_USER_DSH_HOME,
  })

  // The work this approval holds, and the Bot that handed it on (the one waiting for it
  // to come back). Captured while the turn that asks is still running.
  function heldBy(sessionId) {
    const info = rt.live?.get(sessionId)?.info
    const workId = rt.workOf?.(info)
    const work = workId === undefined ? undefined : rt.state.works?.[workId]
    return { ...(workId === undefined ? {} : { work: workId }), ...(work?.from === undefined ? {} : { from: work.from }) }
  }

  // What the Bot that asked for the approval reads when it is refused: which request,
  // and the rule that refused it, so it does not try the same thing again.
  function tellRejected(entry, by, why) {
    const text = `The user rejected your request to run ${entry.tool || 'a tool'}${entry.reason === '' ? '' : ` (${entry.reason})`}. ${why === undefined ? '' : `The team's approval policy refused it: ${why}. `}It stays denied, so do not retry it; ask the user how to proceed if you still need it.`
    void rt.deliver({ fromId: by ?? entry.botId, toId: entry.botId, role: 'approval-rejected', steer: true, text })
      .catch(error => rt.warn('ds-bot: the rejection of %s was not delivered: %s', entry.botId, error))
  }

  // A Bot's own chat: the policy decides first. A routine request never becomes a card;
  // only one it cannot place stays in `pending` and opens DSH's card for the user.
  function decideFor(entry) {
    return decideApproval({ tool: entry.tool, reason: entry.reason, code: entry.detail.code, text: entry.detail.text, paths: policyPaths(entry.botId) })
  }

  // Ahead of DSH's own answerer, which would hold a hidden Session's request unseen.
  ctx.on('approval/request', (request, next) => {
    const sessionId = request.agent?.session?.id ?? request.agent?.id
    const owner = sessionId === undefined ? undefined : rt.groupOwners.get(sessionId)
    const botId = owner?.botId ?? (sessionId === undefined ? undefined : rt.chatOwners.get(sessionId))
    if (botId === undefined) return next()
    const id = randomUUID()
    const entry = {
      id,
      sessionId,
      botId,
      ...(owner ? { roomId: owner.roomId } : {}),
      tool: String(request.toolName ?? ''),
      reason: String(request.reason ?? '').slice(0, 500),
      detail: rt.callDetail?.(sessionId, request.callId) ?? {},
      at: Date.now(),
      ...(owner === undefined ? heldBy(sessionId) : {}),
    }
    const note = () => rt.noteApproval?.(sessionId, { tool: entry.tool, reason: entry.reason.slice(0, 200) })
    const clear = () => {
      pending.delete(id)
      rt.noteApproval?.(sessionId, undefined)
    }
    if (owner !== undefined) {
      // A hidden group Session has no card of its own: the group chat answers it.
      pending.set(id, entry)
      note()
      rt.yieldRoomTurn?.(sessionId)
      return new Promise((resolve) => {
        entry.answer = (outcome) => {
          if (!pending.has(id)) return
          clear()
          resolve(outcome)
        }
        if (request.signal?.aborted) entry.answer('cancelled')
        request.signal?.addEventListener('abort', () => entry.answer('cancelled'), { once: true })
      })
    }
    // The Bot's own chat, first level: the fixed policy table, never a model call.
    const decision = decideFor(entry)
    if (decision.decision !== 'escalate') {
      record(entry, decision.decision === 'allow' ? 'allowed-once' : 'rejected', { decidedBy: 'policy', rule: decision.rule, ruleWhy: decision.why, via: 'policy' })
      if (decision.decision === 'reject') tellRejected(entry, undefined, decision.why)
      return Promise.resolve(decision.decision === 'allow' ? 'allowed-once' : 'rejected')
    }
    // Second level: keep DSH's card and wait in the main chat's inbox, with the reason
    // the policy could not decide.
    entry.rule = decision.rule
    entry.unsure = decision.why
    pending.set(id, entry)
    note()
    const card = Promise.resolve(next())
    return new Promise((resolve, reject) => {
      let done = false
      const finish = (outcome, by, fromCard = false, recorded = false) => {
        if (done) return
        done = true
        clear()
        if (fromCard) record(entry, outcome, { decidedBy: 'user', via: 'card' })
        else if (by !== undefined && !recorded) record(entry, outcome, { decidedBy: 'main-bot', via: 'needs', rule: entry.rule, ruleWhy: entry.unsure, by })
        resolve(outcome)
      }
      entry.answer = (outcome, by) => finish(outcome, by, false, true)
      card.then(
        outcome => finish(outcome, undefined, true),
        (error) => {
          if (done) return
          done = true
          clear()
          reject(error)
        },
      )
      if (request.signal?.aborted) finish('cancelled')
      request.signal?.addEventListener('abort', () => finish('cancelled'), { once: true })
    })
  }, { prepend: true })

  const approvalsView = () => [...pending.values()].map(({ answer, ...entry }) => ({ ...entry, answerable: answer !== undefined }))
  const waitsForApproval = sessionId => [...pending.values()].some(entry => entry.sessionId === sessionId)

  // What waits for the user in a Bot's own chat, one row per conversation: several
  // approvals there are one line that opens into each request, not a flood of rows.
  function approvalNeeds() {
    const groups = new Map()
    for (const entry of pending.values()) {
      if (entry.roomId !== undefined || entry.answer === undefined) continue
      const group = groups.get(entry.sessionId) ?? { botId: entry.botId, sessionId: entry.sessionId, approvals: [] }
      group.approvals.push({
        id: entry.id,
        tool: entry.tool,
        reason: entry.reason,
        ...(entry.detail?.code === undefined ? {} : { detail: entry.detail.code }),
        ...(entry.detail?.text === undefined ? {} : { description: entry.detail.text }),
        unsure: entry.unsure,
        at: entry.at,
      })
      groups.set(entry.sessionId, group)
    }
    return [...groups.values()].map((group) => {
      group.approvals.sort((left, right) => left.at - right.at)
      const first = group.approvals[0]
      const more = group.approvals.length > 1
      return {
        kind: 'approval',
        botId: group.botId,
        bot: nameOf(group.botId),
        sessionId: group.sessionId,
        since: first.at,
        summary: `${first.tool || 'a tool'}${first.reason === '' ? '' : `: ${first.reason}`}`,
        ...(first.unsure === undefined ? {} : { unsure: first.unsure }),
        ...(more ? { more: group.approvals.length - 1 } : {}),
        approvals: group.approvals,
      }
    })
  }

  // One answer for the group card, the details card and the main chat: the outcome DSH
  // understands, and the line that keeps every decision visible.
  function answerApproval(id, choice, by) {
    const entry = pending.get(String(id ?? ''))
    if (entry?.answer === undefined) throw Object.assign(new Error('This approval is no longer open'), { code: 'bot/stale' })
    const outcome = OUTCOMES[choice]
    if (outcome === undefined) throw Object.assign(new Error('Choose allow or reject'), { code: 'bot/invalid' })
    if (by !== undefined && rt.isMain?.(by) !== true) throw Object.assign(new Error('Only a Main Bot can answer for the user'), { code: 'bot/refused' })
    // The group card already gets DSH's own refusal; the extra word is for a Bot whose
    // approval was answered from the main chat or the details panel.
    if (outcome === 'rejected' && entry.roomId === undefined) tellRejected(entry, by)
    record(entry, outcome, by === undefined
      ? { decidedBy: 'user', via: entry.roomId === undefined ? 'card' : 'group', ...(entry.rule === undefined ? {} : { rule: entry.rule, ruleWhy: entry.unsure }) }
      : { decidedBy: 'main-bot', via: 'needs', rule: entry.rule, ruleWhy: entry.unsure, by })
    entry.answer(outcome, by)
  }

  // An approval that waits too long is a blocked work, not a quiet one: tell the Bot that
  // handed it on, once, so it can tell the user or take the work elsewhere. A failed
  // delivery leaves the report for the next sweep rather than swallowing it.
  async function sweepApprovals(at = Date.now()) {
    let changed = false
    for (const entry of pending.values()) {
      if (entry.roomId !== undefined || entry.timeoutReported || entry.reporting) continue
      if (at - entry.at < timeout) continue
      if (entry.from === undefined || entry.from === entry.botId || rt.botOf(entry.from) === undefined) continue
      const min = Math.max(1, Math.round((at - entry.at) / 60_000))
      const unsure = entry.unsure === undefined ? '' : ` The team could not decide on its own: ${entry.unsure}.`
      const text = `${nameOf(entry.botId) ?? 'A Bot'} is blocked waiting for the user's approval to run ${entry.tool || 'a tool'}${entry.reason === '' ? '' : ` (${entry.reason})`}. It has waited ${min} min.${unsure} Answer it under "Needs you" in the main chat (allow once or reject) so it can go on.`
      entry.reporting = true
      try {
        await rt.deliver({ fromId: entry.botId, toId: entry.from, role: 'approval', text })
        entry.timeoutReported = true
        changed = true
      } catch (error) {
        rt.warn('ds-bot: the approval of %s was not reported to %s: %s', entry.botId, entry.from, error)
        rt.noteFault?.('delivery')
      } finally {
        delete entry.reporting
      }
    }
    if (changed) save()
    return changed
  }

  // The approvals the team decided itself and the ones a Main Bot answered for the user,
  // oldest first.
  const approvalAudit = () => auditLog().slice(-20)

  // A group Session that leaves its group has no card left to answer from.
  const cancelApprovals = (sessionId) => {
    for (const entry of pending.values()) {
      if (entry.sessionId === sessionId) entry.answer?.('cancelled')
    }
  }

  rt.ctx?.effect?.(() => {
    const timer = setInterval(() => { void sweepApprovals().catch(() => {}) }, SWEEP_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'ds-bot: report an approval that waits too long')

  Object.assign(rt, { approvalsView, waitsForApproval, answerApproval, cancelApprovals, approvalNeeds, sweepApprovals, approvalAudit })
}
