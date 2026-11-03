// The Main Bot's own work: what each of its turns did alone, and stopping a turn that
// keeps working without handing anything on.
//
// The team exists so that the Main Bot stays free to answer the user. A Main Bot can
// still slip into doing everything itself — real work, no hand-off — and nothing in
// the host used to notice. Each of its turns is now audited (tool calls, shell calls,
// file writes, work handed on, how long it took, and any `keep_working` reason), and a
// turn that crosses the tool threshold without handing work on is stopped with a
// message that says what to do instead.
import { mainGateOf } from './work-state.js'

// The mark a stopped turn carries in its end reason.
export const WORK_GATE = 'ds-bot/work-gate'
const AUDIT_MAX = 500
const DAY_MS = 24 * 60 * 60_000
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'bash-persistent', 'pwsh-persistent'])
const WRITE_TOOLS = new Set(['write', 'edit'])

export function install(rt) {
  const { state } = rt
  const policy = mainGateOf(rt.config)
  // Per Session: the turn that is running, and what it has done so far.
  const turns = new Map()
  const auditLog = () => (state.mainTurns ??= [])
  const save = () => void rt.save().catch(() => {})
  const botOfSession = sessionId => rt.selfOf?.(sessionId)
  const isMainSession = sessionId => rt.isMain?.(botOfSession(sessionId)) === true

  const noteCall = (turn, name) => {
    turn.tools += 1
    if (SHELL_TOOLS.has(name)) turn.bash += 1
    if (WRITE_TOOLS.has(name)) turn.writes += 1
  }

  // The header the delivery adds already says who stopped it; the text says why and what
  // the two ways on are.
  const notice = turn => [
    `This turn made ${turn.tools} tool calls without handing on any work.`,
    'Hand the work to the Bot that fits (create one if none does), or call keep_working with the reason you must do it yourself.',
  ].join('\n')

  // A turn is stopped once: after its tools reach the threshold, with no work handed on
  // and no keep_working behind it. What it was about to do next is what the stop saves.
  function gateIfNeeded(sessionId, turn) {
    if (policy.mode !== 'enforce' || turn.gated || turn.kept !== undefined) return false
    if (turn.dispatched || turn.works > 0) return false
    if (turn.tools < policy.tools) return false
    if (!isMainSession(sessionId)) return false
    turn.gated = true
    const botId = botOfSession(sessionId)
    void (async () => {
      try {
        // The notice reaches the Bot as its next turn's trigger: it reads why the turn
        // stopped and what the alternatives are.
        await rt.deliver({ toId: botId, role: 'gate', text: notice(turn) })
      } catch (error) {
        rt.warn('ds-bot: the work-gate notice to %s was not delivered: %s', botId, error)
      }
      try {
        const agent = await rt.resolveAgent(sessionId)
        agent.cancel({ kind: 'hook', reason: WORK_GATE })
      } catch (error) {
        rt.warn('ds-bot: the work-gate could not stop %s: %s', sessionId, error)
      }
    })()
    return true
  }

  function finish(sessionId, turn, at) {
    if (policy.mode === 'off' || !isMainSession(sessionId)) return
    // A pure answer is not work: only turns that did something are worth a line.
    if (turn.tools === 0 && turn.works === 0 && turn.kept === undefined) return
    auditLog().push({
      at: turn.startedAt,
      ms: Math.max(0, at - turn.startedAt),
      botId: botOfSession(sessionId),
      sessionId,
      tools: turn.tools,
      bash: turn.bash,
      writes: turn.writes,
      works: turn.works,
      ...(turn.kept === undefined ? {} : { kept: turn.kept }),
      ...(turn.gated ? { gated: true } : {}),
    })
    if (auditLog().length > AUDIT_MAX) auditLog().splice(0, auditLog().length - AUDIT_MAX)
    save()
  }

  // What the panel shows: in the last day, how many of the Main Bot's turns were done
  // alone and how much work it handed on.
  function workAudit(at = Date.now()) {
    const recent = auditLog().filter(entry => at - (entry.at ?? 0) < DAY_MS)
    const alone = recent.filter(entry => (entry.tools ?? 0) > 0 && (entry.works ?? 0) === 0).length
    return {
      turns: recent.length,
      alone,
      works: recent.reduce((sum, entry) => sum + (entry.works ?? 0), 0),
      kept: recent.filter(entry => entry.kept !== undefined).length,
    }
  }

  // Work this turn handed to another Bot: a request, a post into a group, or a work it
  // opened for one. A turn that did any of this is never stopped for working alone.
  function noteDispatch(sessionId, { works = 0 } = {}) {
    const turn = turns.get(sessionId)
    if (turn === undefined) return
    turn.dispatched = true
    turn.works += works
  }

  // The explicit way out: the Main Bot says why this work must be its own, and the
  // reason stays in the audit beside the turn it excused.
  function keepWorking(exec, reason) {
    const sessionId = exec.agent?.id
    if (!isMainSession(sessionId)) return { error: 'keep_working is for the Main Bot: another Bot works on its own by design.' }
    const turn = turns.get(sessionId)
    if (turn === undefined) return { error: 'There is no turn running to keep working in.' }
    const why = String(reason ?? '').replace(/\s+/g, ' ').trim()
    if (why === '') return { error: 'Give one sentence on why you must do this work yourself.' }
    turn.kept = why.slice(0, 300)
    return { kept: turn.kept }
  }

  rt.ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (sessionId === undefined) return
    const turn = turns.get(sessionId)
    switch (event.type) {
      case 'turn/start': {
        turns.set(sessionId, {
          startedAt: event.time ?? Date.now(),
          tools: 0,
          bash: 0,
          writes: 0,
          works: 0,
          dispatched: false,
          kept: undefined,
          gated: false,
        })
        break
      }
      case 'tool/call':
      case 'tool/ptc-dispatch-start': {
        if (turn === undefined) break
        noteCall(turn, String(event.data?.name ?? ''))
        break
      }
      case 'tool/result':
      case 'tool/ptc-dispatch': {
        if (turn === undefined) break
        gateIfNeeded(sessionId, turn)
        break
      }
      case 'turn/end': {
        if (turn === undefined) break
        turns.delete(sessionId)
        finish(sessionId, turn, event.time ?? Date.now())
        break
      }
      default:
        break
    }
  })

  Object.assign(rt, { noteDispatch, keepWorking, workAudit, workGate: policy })
}
