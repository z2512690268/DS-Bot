// Model requests that failed for a reason worth another try.
//
// The same `agent/request-error` extension point DSH's own retry executor uses: after
// every downstream handler had its say (the context steward, the provider's own retry
// policy, a Main Bot's recovery), a failure the provider might answer differently in a
// minute — an overload, a dropped connection, an empty completion — is waited out with
// exponential backoff and retried inside the same open turn. The failed step is re-run
// over the same durable history, so tool calls that already finished are not repeated,
// and the turn stays open while it waits: the chain watchdog does not see a stopped
// chain.
//
// A refusal is not retried: a key the provider rejects, an exhausted quota, a malformed
// request. Those fail the same way again, so they are reported at once.
import { llmRetryOf, reportableFailure, retryDelayOf, retryableFailure } from './work-state.js'

export function install(rt) {
  const { ctx, state } = rt
  const policy = llmRetryOf(rt.config)
  // Attempts per failed step: the loop re-runs the same step, so the turn and step
  // numbers name one budget. Cleared when the turn ends.
  const budgets = new Map()
  const KEY_MAX = 200
  const LOG_MAX = 200

  const retryLog = () => (state.llmRetries ??= [])
  function noteRetry(entry) {
    retryLog().push({ at: Date.now(), ...entry })
    if (retryLog().length > LOG_MAX) retryLog().splice(0, retryLog().length - LOG_MAX)
    void rt.save?.()
  }

  const nameOf = sessionId => rt.botOf(rt.selfOf(sessionId))?.name
  const placeOf = (sessionId) => {
    const room = rt.roomOf?.(rt.groupOwners?.get(sessionId)?.roomId)
    return room === undefined ? undefined : `group "${room.name}"`
  }

  // The wait, cut short when the turn is stopped while it runs.
  function sleep(ms, signal) {
    if (signal?.aborted) return Promise.resolve(false)
    return new Promise((resolve) => {
      const timer = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(true) }, ms)
      function onAbort() { clearTimeout(timer); resolve(false) }
      signal?.addEventListener?.('abort', onAbort, { once: true })
    })
  }

  function diagnostic(entry) {
    rt.noteFailure?.({ level: 'warn', source: 'retry', ...entry })
  }

  // One failed request. `next` is every other recovery: whatever it decides wins, so a
  // provider policy that already retries, or a context switch, is never second-guessed.
  async function recoverRequest(payload = {}, next = async () => undefined) {
    const decided = await Promise.resolve().then(() => next())
    if (decided !== undefined) return decided
    const { failure, agent, signal } = payload
    const sessionId = agent?.id
    // A refusal is not waited out: it goes up now, with what the provider said.
    if (reportableFailure(failure)) {
      noteRetry({ sessionId, bot: nameOf(sessionId), attempt: 0, code: failure?.code, outcome: 'gave-up', message: failure?.message })
      diagnostic({ text: `model request refused (${failure?.code ?? 'ERROR'})${failure?.message ? `: ${failure.message.slice(0, 300)}` : ''}; it is not retried`, code: failure?.code, bot: nameOf(sessionId), where: placeOf(sessionId), sessionId })
      rt.failWorkOf?.(sessionId, failure, 0)
      return undefined
    }
    if (policy.attempts <= 0 || signal?.aborted) {
      // Retrying is off, so a transient failure ends here like any other.
      if (retryableFailure(failure) && !signal?.aborted) {
        noteRetry({ sessionId, bot: nameOf(sessionId), attempt: 0, code: failure?.code, outcome: 'gave-up', message: failure?.message })
        rt.failWorkOf?.(sessionId, failure, 0)
      }
      return undefined
    }
    if (!retryableFailure(failure)) return undefined
    const key = `${sessionId ?? ''}:${payload.turn ?? ''}:${payload.step ?? ''}`
    const used = budgets.get(key) ?? 0
    const bot = nameOf(sessionId)
    const where = placeOf(sessionId)
    if (used >= policy.attempts) {
      // Out of attempts: the turn will end failed, and the work must not wait quietly.
      noteRetry({ sessionId, bot, attempt: used, code: failure?.code, outcome: 'gave-up', message: failure?.message })
      diagnostic({ text: `model request failed after ${used} retries (${failure?.code ?? 'ERROR'})${failure?.message ? `: ${failure.message.slice(0, 300)}` : ''}`, code: failure?.code, bot, where, sessionId })
      budgets.delete(key)
      rt.failWorkOf?.(sessionId, failure, used)
      return undefined
    }
    const attempt = used + 1
    const delayMs = retryDelayOf(attempt, policy.baseMs)
    if (budgets.size >= KEY_MAX) budgets.clear()
    budgets.set(key, attempt)
    noteRetry({ sessionId, bot, attempt, max: policy.attempts, delayMs, code: failure?.code, outcome: 'retry' })
    diagnostic({ text: `model request retry ${attempt}/${policy.attempts} in ${delayMs} ms (${failure?.code ?? 'ERROR'})${failure?.message ? `: ${failure.message.slice(0, 300)}` : ''}`, code: failure?.code, bot, where, sessionId })
    const waited = await sleep(delayMs, signal)
    if (!waited) {
      // The turn was stopped while waiting: nothing to retry, and the attempt is not spent.
      budgets.set(key, used)
      return undefined
    }
    return { kind: 'retry' }
  }

  ctx.on('agent/request-error', (payload, next) => recoverRequest(payload, next))

  // A turn that ends is a fresh budget for its next one.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    const prefix = `${session?.id ?? ''}:`
    for (const key of budgets.keys()) if (key.startsWith(prefix)) budgets.delete(key)
  })

  // What the panel's health line shows: retries and give-ups in the last hour.
  function llmRetryView(at = Date.now()) {
    const since = at - 60 * 60_000
    const recent = retryLog().filter(entry => entry.at >= since)
    return {
      retries: recent.filter(entry => entry.outcome === 'retry').length,
      retryFailures: recent.filter(entry => entry.outcome === 'gave-up').length,
    }
  }

  Object.assign(rt, { recoverRequest, llmRetryView, llmRetryPolicy: policy, llmRetryAudit: () => retryLog() })
}
