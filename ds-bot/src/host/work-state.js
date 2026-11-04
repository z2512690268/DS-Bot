// Work state: what a piece of handed-on work waits for, derived from what it holds.
//
// handoffs.js keeps the work tree, and statusOf says what a Bot is doing. The other
// question a Bot has to guess today is what one piece of work waits for, and since
// when: a question of the user, a result that came back, a report that could not go
// on, or nothing but time. A model may report its judgement (report.js in tools.js),
// but the state itself is derived, so an idle work cannot be described as a finished
// one by whoever happens to be writing the answer.

// What a Bot may report about the work it answers. `progress` leaves the work open and
// stays out of the answer; the rest travel up with the answer.
export const REPORT_STATES = ['progress', 'ready', 'blocked', 'failed', 'dropped']
// A work that ends without a report is done: that is what a plain answer has always meant.
export const DEFAULT_REPORT = 'ready'

/**
 * The state of one work, first matching row: a question for the user, a report that
 * could not go on, a report of a result, or the work itself. `since` is the moment
 * that state began, so callers can say how long it has waited.
 */
export function workStateOf(work, at = Date.now()) {
  if (work === undefined) return { state: 'ended', since: at }
  const { attention } = work
  if (attention !== undefined && attention.answeredAt === undefined) {
    return { state: 'person/answer', since: attention.at ?? work.at, question: attention.question }
  }
  // Work a Bot started on its own, recorded instead of done: only the user can turn it
  // into work, so it waits next to the questions rather than under the running work.
  if (work.proposal !== undefined) {
    return { state: 'person/proposed', since: work.proposal.at ?? work.at, proposed: true, summary: work.proposal.summary ?? work.proposal.text }
  }
  const { report } = work
  if (report !== undefined) {
    const since = report.at ?? work.at
    if (report.state === 'blocked') return { state: 'person/blocked', since, summary: report.summary, humanAction: report.humanAction, ...(report.reason === undefined ? {} : { reason: report.reason }) }
    if (report.state === 'failed') return { state: 'person/failed', since, summary: report.summary, humanAction: report.humanAction }
    if (report.state === 'ready') return { state: 'person/review', since, summary: report.summary }
  }
  return { state: 'working', since: report?.at ?? work.at }
}

/** True when the state is one only the user can end: a question, a blocker, a result to review. */
export const waitsForUser = state => state.startsWith('person/')

// How much work a Bot may start on its own: `off` (only what was asked for),
// `observe` (record what it would have done, and do nothing), `auto` (do it).
export const PROACTIVE_MODES = ['off', 'observe', 'auto']
export const PROACTIVE_MODE = 'observe'

// How long an approval in a Bot's own chat may wait before the Bot that handed the work
// on hears that it is blocked. Short on purpose: the user may be in another chat and
// would otherwise never learn that a Bot stopped there.
export const APPROVAL_TIMEOUT_MS = 2 * 60_000

/** The approval timeout this team runs: the constant above, overridden by plugin config. */
export function approvalTimeoutOf(config = {}) {
  const minutes = Number(config.approvalTimeoutMinutes)
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : APPROVAL_TIMEOUT_MS
}

// How long a Main Bot turn may keep the user waiting: `off` stops nothing and records
// nothing, `audit` only records, `enforce` also interrupts. The limits are time, not
// counts, and a turn that handed work on is held to them just the same:
//
// - `softSeconds`: a reflection is steered into the running turn, asking the Main Bot to
//   hand it on, narrow it, or say why it must continue (once per turn);
// - `hardSeconds`: the turn is stopped; only `keep_working` lets it go on;
// - `sameTarget`: the auxiliary repeat limit — the same tool on the same host, path or
//   service this many times, which usually means it is doing a Bot's debugging.
export const MAIN_GATE_MODES = ['off', 'audit', 'enforce']
export const MAIN_GATE_MODE = 'enforce'
export const MAIN_GATE_SOFT_SECONDS = 45
export const MAIN_GATE_HARD_SECONDS = 120
export const MAIN_GATE_SAME_TARGET = 4

/** The Main Bot's own-work gate: the constants above, overridden by plugin config. */
export function mainGateOf(config = {}) {
  const seconds = (value, fallback) => {
    const count = Number(value)
    return Number.isFinite(count) && count > 0 ? count : fallback
  }
  const calls = (value, fallback) => {
    const count = Number(value)
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : fallback
  }
  return {
    mode: MAIN_GATE_MODES.includes(config.mainWorkGate) ? config.mainWorkGate : MAIN_GATE_MODE,
    softSeconds: seconds(config.mainTurnSoftSeconds, MAIN_GATE_SOFT_SECONDS),
    hardSeconds: seconds(config.mainTurnHardSeconds, MAIN_GATE_HARD_SECONDS),
    sameTarget: calls(config.mainWorkSameTarget, MAIN_GATE_SAME_TARGET),
  }
}

/** The team's proactive mode: the constant above, overridden by plugin config. */
export const proactiveOf = (config = {}) => (PROACTIVE_MODES.includes(config.proactive) ? config.proactive : PROACTIVE_MODE)

/**
 * The line a report adds above the answer that goes up the tree. Empty when the work
 * carries no report, so a plain answer is unchanged.
 */
export function reportLine(report) {
  if (report === undefined) return ''
  const summary = String(report.summary ?? '').trim()
  const head = summary === '' ? report.state : `${report.state}: ${summary}`
  const ask = String(report.humanAction ?? '').trim()
  return `[reported ${head}]${ask === '' ? '' : `\n${ask}`}`
}

/**
 * What a report on this work means for the Bot that reported it: stored shape, or the
 * complaint to give back when the report cannot be kept.
 */
export function normalizeReport(input = {}, at = Date.now()) {
  const state = REPORT_STATES.includes(input.state) ? input.state : undefined
  if (state === undefined) return { error: `A report is one of ${REPORT_STATES.join(', ')}.` }
  const summary = String(input.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 500)
  const humanAction = String(input.human_action ?? '').replace(/\s+/g, ' ').trim().slice(0, 500)
  const asked = Array.isArray(input.human_options) ? input.human_options : []
  const humanOptions = [...new Set(asked
    .map(option => String(typeof option === 'string' ? option : option?.label ?? '').replace(/\s+/g, ' ').trim())
    .filter(label => label !== ''))].slice(0, 4)
  return {
    report: {
      state,
      ...(summary === '' ? {} : { summary }),
      ...(humanAction === '' ? {} : { humanAction }),
      ...(humanAction !== '' && humanOptions.length > 0 ? { humanOptions } : {}),
      at,
    },
  }
}

/** How long a work may go without a report before the code marks it stale. */
export const STALL_MS = 30 * 60_000

// How long a work may wait for that report, defaulted here instead of at each call.
// `notify`: the Bot that asked reads that it stalled at its next turn. `redispatch`:
// the same task also goes back to the Bot that held it, once per stall.
export const LEASE_ACTIONS = ['notify', 'redispatch']
export const LEASE_POLICY = { action: 'notify', deadline: STALL_MS }

/** The lease policy this team runs: the constants above, overridden by plugin config. */
export function leasePolicyOf(config = {}) {
  const minutes = Number(config.workDeadlineMinutes)
  return {
    action: LEASE_ACTIONS.includes(config.leaseAction) ? config.leaseAction : LEASE_POLICY.action,
    deadline: Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : LEASE_POLICY.deadline,
  }
}

// A background job is expected to take about half an hour; waiting for one is progress.
// Past twice that, a job that has written nothing for as long is stuck as far as the
// team can tell, and the work it holds may be marked stale again.
export const JOB_EXPECTED_MS = 30 * 60_000
export const JOB_GRACE_MS = 2 * JOB_EXPECTED_MS

/**
 * True while a live background job of the Bot that holds the work is itself making
 * progress: it is young enough to be expected to run, or it wrote something recently.
 * Older and silent past the grace, it no longer excuses the silence.
 */
export function jobInProgress(job, at = Date.now(), grace = JOB_GRACE_MS) {
  if (job === undefined) return false
  const since = job.lastActivityAt ?? job.startedAt
  if (!Number.isFinite(since)) return false
  return at - since < grace
}

/**
 * The report a work that stopped reporting gets, or undefined while it is young
 * enough or has already reported an outcome. `reason` names the fact for the Bot that
 * asked: the lease ran out without a word, which is not the same as the owner saying
 * it is blocked.
 */
export function stalledReport(work, at = Date.now(), deadline = STALL_MS) {
  if (work === undefined) return undefined
  // A proposal was never handed to anyone, so it has no lease to run out.
  if (work.proposal !== undefined) return undefined
  if (work.report !== undefined && work.report.state !== 'progress') return undefined
  const since = work.progress?.at ?? work.lease?.at ?? work.at ?? at
  if (at - since < deadline) return undefined
  const min = Math.max(1, Math.round((at - since) / 60_000))
  return { state: 'blocked', summary: `no progress for ${min} min`, at, stalled: true, reason: 'no_progress' }
}
