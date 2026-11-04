// The Main Bot's own work: what each of its turns did alone, and interrupting a turn
// that keeps working instead of handing work on.
//
// The team exists so that the Main Bot stays free to answer the user. A Main Bot can
// still slip into doing everything itself — real work, no hand-off — and nothing in
// the host used to notice. Each of its turns is audited (tool calls, shell calls, file
// writes, work handed on, how long it took, and any `keep_working` reason). A turn that
// runs too long is interrupted: a reflection at the soft line, a stop at the hard line.
// A third, ancillary limit stops a turn that repeats one tool on the same host, path or
// service: that usually means it is doing a Bot's work for it. Handing work on does not
// exempt a turn from any of them; `keep_working` is the explicit way out, and it is
// recorded.
//
// Time is measured from the turn's start on a monotonic clock and is forgotten when the
// turn ends or is stopped, so no turn inherits another's seconds.
import { mainGateOf } from './work-state.js'

// The mark a stopped turn carries in its end reason.
export const WORK_GATE = 'ds-bot/work-gate'
const AUDIT_MAX = 500
const DAY_MS = 24 * 60 * 60_000
const SWEEP_MS = 5_000
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'bash-persistent', 'pwsh-persistent'])
const WRITE_TOOLS = new Set(['write', 'edit'])
const DISPATCH_TOOLS = new Set(['message_bot', 'post_to_group', 'keep_working'])
// While the hard line is on, only these four tools run; everything else is refused.
const HARD_ALLOWED = new Set(['message_bot', 'post_to_group', 'create_bot', 'keep_working'])
export const HARD_REFUSAL = '硬线已触发，先把活派出去，或 keep_working 说明理由'

const textOf = value => String(value ?? '').trim()
const stripQuotes = value => String(value ?? '').replace(/^['"]|['"]$/g, '')
const hostOf = (value) => {
  try { return new URL(String(value)).host } catch { return undefined }
}

// The options whose value is the next word, for `ssh` and `scp`.
const OPTION_ARG = new Set(['-p', '-i', '-o', '-l', '-L', '-R', '-D', '-J', '-F', '-c', '-m', '-O', '-Q', '-S', '-W', '-w', '-b', '-E', '-e', '-I', '-P'])

function sshHost(rest) {
  const tokens = rest.trim().split(/\s+/).filter(Boolean)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = stripQuotes(tokens[index])
    if (token.startsWith('-')) {
      if (OPTION_ARG.has(token)) index += 1
      continue
    }
    const at = token.lastIndexOf('@')
    const host = (at === -1 ? token : token.slice(at + 1)).split(':')[0]
    if (host !== '') return host
  }
  return undefined
}

function scpHost(rest) {
  const tokens = rest.trim().split(/\s+/).filter(Boolean).map(stripQuotes)
  const remote = tokens.find(token => !token.startsWith('-') && (token.includes(':') || token.includes('@')))
  const chosen = remote ?? [...tokens].reverse().find(token => !token.startsWith('-'))
  if (chosen === undefined) return undefined
  const at = chosen.lastIndexOf('@')
  return (at === -1 ? chosen : chosen.slice(at + 1)).split(':')[0] || undefined
}

function shellTargetOf(command) {
  const ssh = /\bssh\s+([^\n]*)/i.exec(command)
  if (ssh !== null) {
    const host = sshHost(ssh[1])
    if (host !== undefined) return `host:${host}`
  }
  const scp = /\b(?:scp|sftp)\s+([^\n]*)/i.exec(command)
  if (scp !== null) {
    const host = scpHost(scp[1])
    if (host !== undefined) return `host:${host}`
  }
  const url = /https?:\/\/[^\s'"`]+/i.exec(command)
  if (url !== null) {
    const host = hostOf(url[0])
    if (host !== undefined) return `url:${host}`
  }
  const unit = /\bsystemctl\s+(?:restart|start|stop|reload|status|enable|disable)\s+([\w@.-]+)/i.exec(command)
  if (unit !== null) return `service:${unit[1]}`
  const service = /\bservice\s+([\w@.-]+)\s+(?:restart|start|stop|status|reload)/i.exec(command)
  if (service !== null) return `service:${service[1]}`
  const docker = /\bdocker\s+(?:restart|start|stop|rm|exec)\s+(?:-[^\s]+\s+)*([\w@.-]+)/i.exec(command)
  if (docker !== null) return `service:${docker[1]}`
  const path = /(?:^|[\s'"=:(])(\/(?:[^\s'"`;|&)]+))/i.exec(command)
  if (path !== null) return `path:${path[1]}`
  return undefined
}

// What a call is about, for the repeat limit: the host an ssh/scp call reaches, the
// service it restarts, the path it reads or writes, or the URL host it fetches. A call
// with no such subject is not counted; a hand-off is never a subject.
export function toolTargetOf(name, args = {}) {
  const tool = String(name ?? '')
  if (tool === '' || DISPATCH_TOOLS.has(tool)) return undefined
  const command = textOf(args.command ?? args.cmd ?? args.script)
  if (command !== '' && SHELL_TOOLS.has(tool)) return shellTargetOf(command)
  const file = stripQuotes(args.file_path ?? args.path)
  if (file !== '') return `path:${file}`
  const url = textOf(args.url)
  if (url !== '') {
    const host = hostOf(url)
    if (host !== undefined) return `url:${host}`
  }
  return undefined
}

function argumentsOf(data) {
  const raw = data?.arguments ?? data?.args
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return {} }
  }
  return raw !== null && typeof raw === 'object' ? raw : {}
}

export function install(rt) {
  const { state } = rt
  const policy = mainGateOf(rt.config)
  // Per Session: the turn that is running, and what it has done so far.
  const turns = new Map()
  // Per Session, the stop the next turn answers: `keep_working` there links its reason
  // back to the gate that stopped the previous turn.
  const lastStop = new Map()
  const auditLog = () => (state.mainTurns ??= [])
  const save = () => void rt.save().catch(() => {})
  const botOfSession = sessionId => rt.selfOf?.(sessionId)
  const isMainSession = sessionId => rt.isMain?.(botOfSession(sessionId)) === true
  // The turn clock is monotonic; a test may substitute one through `rt.monotonicNow`.
  const now = () => {
    const value = rt.monotonicNow?.()
    return typeof value === 'number' && Number.isFinite(value) ? value : performance.now()
  }
  const secondsSince = (turn, at = now()) => Math.max(0, (at - turn.startedAt) / 1_000)
  const secondsOf = value => Math.max(1, Math.round(value))

  const noteCall = (turn, name, args) => {
    turn.tools += 1
    if (SHELL_TOOLS.has(name)) turn.bash += 1
    if (WRITE_TOOLS.has(name)) turn.writes += 1
    const target = toolTargetOf(name, args)
    if (target === undefined) {
      turn.lastCall = undefined
      return
    }
    const key = `${name}:${target}`
    const count = (turn.targets.get(key) ?? 0) + 1
    turn.targets.set(key, count)
    turn.lastCall = { tool: name, target, count }
  }

  // The text the model reads (and the audit keeps verbatim). The hard line also tells
  // the model how to answer the user: one sentence of where things stand and the exact
  // "stopped, waiting for your next instruction" line, with no further explanation.
  function noticeOf(gate, turn) {
    if (gate.id === 'soft') {
      return `This turn has been running ${secondsOf(gate.seconds)} sec and has made ${turn.tools} tool calls. Can this work be handed to a Bot? Can it be narrowed? Your next message must hand it on, narrow it, or call keep_working with the reason you must continue.`
    }
    if (gate.id === 'hard') {
      return `Hard line: this turn has passed ${secondsOf(gate.seconds)} sec. Only message_bot, post_to_group, create_bot and keep_working can run now. Hand the work to a Bot and say who you gave it to, or call keep_working with the reason you must continue.`
    }
    return `This turn has called ${gate.tool} on ${gate.target} ${gate.count} times. That machine or thing already has a Bot responsible; hand the work back, or call keep_working with the reason you must do it yourself.`
  }

  function recordOf(gate, turn, text) {
    return {
      gate: gate.id,
      at: Date.now(),
      ...(gate.id === 'soft' || gate.id === 'hard' ? { seconds: Math.round(gate.seconds), limit: gate.id === 'soft' ? policy.softSeconds : policy.hardSeconds } : {}),
      ...(gate.id === 'hard' ? { rejected: 0 } : {}),
      ...(gate.id === 'same-target' ? { threshold: gate.threshold, tool: gate.tool, target: gate.target, count: gate.count } : {}),
      tools: turn.tools,
      dispatched: turn.dispatched,
      text,
    }
  }

  // The same-target line stops the turn once. In audit mode the gate is recorded but
  // nothing is delivered or cancelled; in enforce the notice goes to the next turn and
  // the turn is cut.
  function stopTurn(sessionId, turn, gate) {
    const text = noticeOf(gate, turn)
    turn.gates.push(recordOf(gate, turn, text))
    turn.gated = true
    if (policy.mode !== 'enforce') return true
    turn.stopped = true
    lastStop.set(sessionId, { gate: gate.id, at: Date.now() })
    const botId = botOfSession(sessionId)
    void (async () => {
      try {
        const agent = await rt.resolveAgent(sessionId)
        // Abort the active operation before anything else: a tool call that is already
        // running gets the turn's abort signal, so a long foreground command is cut
        // now rather than when it happens to return.
        agent.cancel({ kind: 'hook', reason: WORK_GATE })
      } catch (error) {
        rt.warn('ds-bot: the work-gate could not stop %s: %s', sessionId, error)
      }
      try {
        await rt.deliver({ toId: botId, role: 'gate', text })
      } catch (error) {
        rt.warn('ds-bot: the work-gate notice to %s was not delivered: %s', botId, error)
      }
    })()
    return true
  }

  // The hard line does not end the turn: it turns on dispatch-only mode. A steer tells
  // the model what may still run; the guard below refuses every other tool.
  function enterHardLine(sessionId, turn, gate) {
    const text = noticeOf(gate, turn)
    turn.gates.push(recordOf(gate, turn, text))
    turn.hardLine = true
    if (policy.mode !== 'enforce') return true
    turn.dispatchOnly = true
    const botId = botOfSession(sessionId)
    void (async () => {
      if (turns.get(sessionId) !== turn || turn.dispatchOnly !== true) return
      try {
        await rt.deliver({ toId: botId, role: 'gate-hard', text, steer: true })
      } catch (error) {
        rt.warn('ds-bot: the hard-line notice to %s was not delivered: %s', botId, error)
      }
    })()
    return true
  }

  // The soft line does not stop the turn: it is steered into the running turn, so the
  // next model step sees it. It is sent once per turn.
  function remindSoft(sessionId, turn, gate) {
    const text = noticeOf(gate, turn)
    turn.softNotified = true
    turn.gates.push(recordOf(gate, turn, text))
    if (policy.mode !== 'enforce') return true
    const botId = botOfSession(sessionId)
    void (async () => {
      if (turns.get(sessionId) !== turn || turn.gated || turn.hardLine) return
      try {
        await rt.deliver({ toId: botId, role: 'gate-soft', text, steer: true })
      } catch (error) {
        rt.warn('ds-bot: the time check to %s was not delivered: %s', botId, error)
      }
    })()
    return true
  }

  function timeGateIfNeeded(sessionId, turn, at = now()) {
    if (policy.mode === 'off' || turn.gated || turn.kept !== undefined || turn.hardLine) return false
    if (!isMainSession(sessionId)) return false
    const seconds = secondsSince(turn, at)
    if (seconds >= policy.hardSeconds) return enterHardLine(sessionId, turn, { id: 'hard', seconds })
    if (!turn.softNotified && seconds >= policy.softSeconds) return remindSoft(sessionId, turn, { id: 'soft', seconds })
    return false
  }

  // The auxiliary repeat limit: the same tool on the same host, path or service. It is
  // not about time; it catches "I am debugging this Bot's environment for it".
  function repeatGateIfNeeded(sessionId, turn) {
    if (policy.mode === 'off' || turn.gated || turn.kept !== undefined) return false
    if (!isMainSession(sessionId)) return false
    const last = turn.lastCall
    if (last === undefined || last.count < policy.sameTarget) return false
    return stopTurn(sessionId, turn, { id: 'same-target', threshold: policy.sameTarget, ...last })
  }

  // The timer half of the time gates: a turn can outlive its last tool result, so the
  // host itself looks at the clock every few seconds.
  function sweepWorkGate(at = now()) {
    let changed = false
    for (const [sessionId, turn] of turns) {
      if (policy.mode === 'off' || turn.gated || turn.kept !== undefined || turn.hardLine) continue
      if (timeGateIfNeeded(sessionId, turn, at)) changed = true
    }
    return changed
  }

  function finish(sessionId, turn) {
    if (policy.mode === 'off' || !isMainSession(sessionId)) return
    // A pure answer is not work: only turns that did something (or were checked) are
    // worth a line.
    if (turn.tools === 0 && turn.works === 0 && turn.kept === undefined && turn.gates.length === 0) return
    // The hard line's outcome is known only when the turn ends: did it hand work on,
    // say keep_working, or simply end? The rejected count is the calls the guard denied.
    const hard = turn.gates.find(gate => gate.gate === 'hard')
    if (hard !== undefined) {
      hard.rejected = turn.rejected
      hard.outcome = turn.hardOutcome ?? 'ended'
      if (turn.hardTarget !== undefined) hard.target = turn.hardTarget
      if (turn.kept !== undefined) hard.kept = turn.kept
    }
    auditLog().push({
      at: turn.startedAtWall,
      ms: Math.max(0, now() - turn.startedAt),
      botId: botOfSession(sessionId),
      sessionId,
      tools: turn.tools,
      bash: turn.bash,
      writes: turn.writes,
      works: turn.works,
      ...(turn.kept === undefined ? {} : { kept: turn.kept }),
      ...(turn.keptFrom === undefined ? {} : { keptFrom: turn.keptFrom }),
      ...(turn.stopped ? { gated: true } : {}),
      ...(turn.gates.length === 0 ? {} : { gates: turn.gates }),
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
  // opened for one. It marks the audit; it does not exempt the turn from the time gates.
  function noteDispatch(sessionId, { works = 0, target } = {}) {
    const turn = turns.get(sessionId)
    if (turn === undefined) return
    turn.dispatched = true
    turn.works += works
    // A successful hand-off lifts the hard line's dispatch-only state; the target is
    // kept for the audit.
    if (turn.dispatchOnly) {
      turn.dispatchOnly = false
      turn.hardOutcome = 'dispatched'
      turn.hardTarget = target
    }
  }

  // The explicit way out: the Main Bot says why this work must be its own, and every
  // remaining gate in this turn is off; the reason stays in the audit.
  function keepWorking(exec, reason) {
    const sessionId = exec.agent?.id
    if (!isMainSession(sessionId)) return { error: 'keep_working is for the Main Bot: another Bot works on its own by design.' }
    const turn = turns.get(sessionId)
    if (turn === undefined) return { error: 'There is no turn running to keep working in.' }
    const why = String(reason ?? '').replace(/\s+/g, ' ').trim()
    if (why === '') return { error: 'Give one sentence on why you must do this work yourself.' }
    turn.kept = why.slice(0, 300)
    if (turn.dispatchOnly) {
      turn.dispatchOnly = false
      turn.hardOutcome = 'keep_working'
    }
    if (turn.resumedFrom !== undefined) turn.keptFrom = turn.resumedFrom.gate
    return { kept: turn.kept }
  }

  rt.ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (sessionId === undefined) return
    const turn = turns.get(sessionId)
    switch (event.type) {
      case 'turn/start': {
        const resumedFrom = lastStop.get(sessionId)
        lastStop.delete(sessionId)
        turns.set(sessionId, {
          startedAt: now(),
          startedAtWall: Date.now(),
          tools: 0,
          bash: 0,
          writes: 0,
          works: 0,
          dispatched: false,
          targets: new Map(),
          lastCall: undefined,
          gates: [],
          softNotified: false,
          hardLine: false,
          dispatchOnly: false,
          rejected: 0,
          hardOutcome: undefined,
          hardTarget: undefined,
          kept: undefined,
          keptFrom: undefined,
          resumedFrom,
          gated: false,
          stopped: false,
        })
        break
      }
      case 'tool/call':
      case 'tool/ptc-dispatch-start': {
        if (turn === undefined) break
        noteCall(turn, String(event.data?.name ?? ''), argumentsOf(event.data))
        break
      }
      case 'tool/result':
      case 'tool/ptc-dispatch': {
        if (turn === undefined) break
        if (!repeatGateIfNeeded(sessionId, turn)) timeGateIfNeeded(sessionId, turn)
        break
      }
      case 'turn/end': {
        if (turn === undefined) break
        turns.delete(sessionId)
        finish(sessionId, turn)
        break
      }
      default:
        break
    }
  })

  rt.ctx?.effect?.(() => {
    const timer = setInterval(() => { sweepWorkGate() }, SWEEP_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'ds-bot: check the Main Bot turn time')

  // While the hard line is on, only handing work on (or keep_working) may run. This
  // guard runs before the tool body, so a denied call never executes.
  rt.ctx.tools.guard((exec) => {
    if (policy.mode !== 'enforce') return undefined
    const sessionId = exec.agent?.id
    if (!isMainSession(sessionId)) return undefined
    const turn = turns.get(sessionId)
    if (turn === undefined || turn.dispatchOnly !== true) return undefined
    if (HARD_ALLOWED.has(exec.name)) return undefined
    turn.rejected += 1
    return HARD_REFUSAL
  })

  Object.assign(rt, { noteDispatch, keepWorking, workAudit, workGate: policy, sweepWorkGate })
}
