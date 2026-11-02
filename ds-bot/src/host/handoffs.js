// Hand-offs: the work Bots give each other, and what each Bot is doing right now.
//
// A Bot's request to another Bot is a piece of work. What the recipient hands on while
// it works on it hangs below it, and the recipient's answer goes up only once all of
// that came back, together with what came back. Results find their way up by
// themselves, so no Bot needs to message one that waits for it, and that is the one
// hand-off refused. The open works are kept in state.json so a restart waits on.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MESSAGE_INLINE_MAX, TEXT_KEPT, WORK_LOG_MAX } from './constants.js'
import { headOf } from './text.js'
import { leasePolicyOf, normalizeReport, proactiveOf, reportLine, stalledReport, waitsForUser, workStateOf } from './work-state.js'

const minutes = since => {
  const count = Math.floor((Date.now() - since) / 60_000)
  return count < 1 ? 'for less than a minute' : `for ${count} min`
}

export function install(rt) {
  const { state } = rt
  const works = () => (state.works ??= {})
  // What came back, whole; state.json keeps the start of each.
  const whole = new Map()
  const save = () => void rt.save().catch(() => {})
  const nameOf = id => rt.botOf(id)?.name
  // What the team does when a lease runs out: a constant, or the plugin config.
  const leasePolicy = leasePolicyOf(rt.config)
  // How much work a Bot may start on its own, likewise.
  const proactive = proactiveOf(rt.config)

  // What closed work leaves behind: the numbers a later question about it needs. The
  // work itself leaves `works` when it is answered, so these stay in a short log.
  const workLog = () => (state.workLog ??= [])
  function recordClosed(id, work, fallback) {
    const closedAt = Date.now()
    workLog().push({
      id,
      final: work.report?.state ?? fallback,
      authority: work.authority ?? 'delegated',
      turns: work.turns ?? 0,
      results: (work.results ?? []).length,
      ...(work.at === undefined ? {} : { at: work.at, ms: Math.max(0, closedAt - work.at) }),
      closedAt,
      ...(work.report?.summary === undefined ? {} : { summary: work.report.summary }),
      history: [...(work.history ?? []), { at: closedAt, event: 'closed', final: work.report?.state ?? fallback }].slice(-HISTORY_MAX),
    })
    if (workLog().length > WORK_LOG_MAX) workLog().splice(0, workLog().length - WORK_LOG_MAX)
  }
  // A turn that answers the work is one round of it. Not saved on its own: the turn
  // that runs it saves the work anyway, and a lost count is not worth a second write.
  function noteWorkTurn(id) {
    const work = works()[id]
    if (work === undefined) return
    work.turns = (work.turns ?? 0) + 1
  }

  // The timeline a work leaves: what happened to it, oldest first, from the moment it
  // was opened to the moment it was answered. Enough for a panel, not a transcript.
  const HISTORY_MAX = 20
  function pushHistory(work, event) {
    const list = (work.history ??= [])
    list.push(event)
    if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX)
  }
  function workHistory(id) {
    const work = works()[id]
    if (work !== undefined) return work.history ?? []
    return (state.workLog ?? []).find(entry => entry.id === id)?.history ?? []
  }

  // A delivery that failed, or an answer that never reached the Bot that asked. Kept
  // for an hour: the panel answers "is the system healthy now", not "was it ever".
  const HEALTH_WINDOW_MS = 60 * 60_000
  const FAULT_KINDS = ['delivery', 'answer']
  function noteFault(kind) {
    if (!FAULT_KINDS.includes(kind)) return
    const faults = (state.workFaults ??= {})
    const list = (faults[kind] ??= [])
    list.push(Date.now())
    if (list.length > 50) list.splice(0, list.length - 50)
    save()
  }

  // The whole result of a work, in a file of its own: state.json is written whole on
  // every save, so it keeps only the start of a long result, and a restart would cut
  // that result short before it reached the Bot that asked for it.
  const resultsDir = join(rt.home, 'handoff-results')
  const resultPath = name => join(resultsDir, name)
  // A work id is a UUID, but a saved team could carry any name: it stays inside the
  // folder, and one that is not plain falls back to a hash of the id.
  const resultName = id => {
    const text = String(id)
    return `${/^[A-Za-z0-9_-]{1,80}$/.test(text) ? text : createHash('sha256').update(text).digest('hex')}.txt`
  }
  const keptName = file => (typeof file === 'string' && /^[A-Za-z0-9_-]+\.txt$/.test(file) ? file : undefined)
  const writes = () => rt.readOnly?.() === undefined

  // The result of a work, whole, in a file of its own. The file is written before the
  // team file names it, so a result that is claimed to exist is there.
  function keepResult(id, text) {
    if (text.length <= TEXT_KEPT || !writes()) return undefined
    const name = resultName(id)
    const path = resultPath(name)
    const temp = `${path}.${process.pid}.tmp`
    try {
      mkdirSync(resultsDir, { recursive: true })
      writeFileSync(temp, text, 'utf8')
      renameSync(temp, path)
      return name
    } catch (error) {
      rt.warn('ds-bot: result of work %s not kept whole: %s', id, error)
      try {
        rmSync(temp, { force: true })
      } catch {}
      return undefined
    }
  }

  // The copy of a result that is not needed any more: the answer it went into has it.
  const dropResult = file => {
    const name = keptName(file)
    if (name === undefined || !writes()) return
    try {
      // save() can resolve without writing during shutdown. Check the durable
      // references too, so an old state can still recover its result after restart.
      const saved = JSON.parse(readFileSync(join(rt.home, 'state.json'), 'utf8'))
      if (Object.values(saved.works ?? {}).some(work => (work.results ?? []).some(result => result.file === name))) return
      rmSync(resultPath(name), { force: true })
    } catch {}
  }

  // What came back for a work: the whole result if it is still to be found, else the
  // start of it. A result that a restart cut, or whose file is gone, is reported as
  // such and not passed on as if it were whole.
  function resultText(result) {
    if (whole.has(result.id)) return { text: whole.get(result.id), whole: true }
    if (result.length === undefined) return { text: result.text ?? '', whole: true }
    const name = keptName(result.file)
    if (name !== undefined) {
      try {
        const text = readFileSync(resultPath(name), 'utf8')
        if (text.length === result.length) return { text, whole: true }
      } catch {
        // The file is gone or unreadable: the start of the result is all there is.
      }
    }
    return { text: result.text ?? '', whole: false }
  }

  // The work a turn does: the request it answers, or the work a result that came back
  // (or a turn picked up again) goes on with.
  const workOf = info => (info === undefined ? undefined
    : info.role === 'request' && info.audience !== 'user' ? info.exchangeId : info.work)

  // `parent`: the work the sender was doing when it sent this one. `child`: the
  // session id of the subagent a run of this work belongs to — the run, not the
  // child, is the sub-work, so a child that is continued hands up a result per run.
  // `authority`: `asked` when the user asked for it, `delegated` when another Bot did,
  // `proposed` when a Bot started it on its own. It is context for people, not a gate:
  // Bots act on messages, so the plugin has nothing to refuse at this point.
  function openWork(id, { from, to, parent, fromRoom, room, name, child, authority }) {
    const above = parent === undefined ? undefined : works()[parent]
    const at = Date.now()
    works()[id] = { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(room ? { room } : {}), ...(above ? { parent } : {}), ...(fromRoom ? { fromRoom } : {}), ...(name ? { name } : {}), ...(child ? { child } : {}), authority: authority ?? 'delegated', lease: { at, by: to }, open: [], results: [], at, history: [{ at, event: 'created', authority: authority ?? 'delegated' }] }
    if (above !== undefined) above.open.push(id)
    save()
  }

  // Work a Bot starts on its own: under `observe` it is only recorded, so the user
  // reads what the Bot would have done next to the work it belongs to, and nothing is
  // sent; `off` refuses it above. A proposal is never put in its parent's `open`: the
  // Bot that asked waits for the results it actually handed on, not for this.
  function propose({ from, to, parent, text, room }) {
    const work = String(text ?? '').replace(/\r\n?/g, '\n').trim()
    if (from === undefined || to === undefined || work === '') return undefined
    // The same proposal repeated in the same chat would only crowd the list.
    const kept = headOf(work, TEXT_KEPT)
    const earlier = Object.entries(works()).find(([, other]) => other.proposal !== undefined
      && other.from === from && other.to === to && other.proposal.text === kept)
    if (earlier !== undefined) return earlier[0]
    const at = Date.now()
    const id = randomUUID()
    // The whole message is kept, up to what a message may be inline: approving has to
    // send exactly what the Bot would have sent. A longer one cannot be approved as it
    // was, and the next line says so.
    const whole = headOf(work, MESSAGE_INLINE_MAX)
    works()[id] = {
      from,
      to,
      ...(room !== undefined ? { room } : {}),
      ...(works()[parent] !== undefined ? { parent } : {}),
      authority: 'proposed',
      lease: { at, by: to },
      proposal: { at, text: whole, summary: kept, ...(work.length > MESSAGE_INLINE_MAX ? { length: work.length } : {}) },
      open: [],
      results: [],
      at,
      history: [{ at, event: 'proposed', text: kept }],
    }
    save()
    return id
  }

  // What a request sent from this turn is: the authority of the work the Bot answers,
  // else what started the turn. A Bot the user spoke to, a member the user named, or a
  // Bot that another Bot called, was asked. A member the group's admin leads speaking
  // in turn speaks from the group's context, so what it hands on is its own initiative:
  // that is the work the observe mode keeps as a proposal.
  function workAuthorityOf(exec) {
    const turn = rt.live.get(exec.agent?.id)
    for (const id of [workOf(turn?.info), ...(turn?.joined ?? []).map(joined => workOf(joined.info))].filter(Boolean)) {
      const authority = works()[id]?.authority
      if (authority !== undefined) return authority
    }
    const { info } = turn ?? {}
    if (info?.role === 'room') {
      if (info.askedBy !== undefined || info.namedByUser === true) return 'asked'
      const owner = rt.groupOwners?.get(exec.agent?.id)
      const room = owner === undefined ? undefined : rt.roomOf(owner.roomId)
      return room !== undefined && rt.isAdminOf?.(room, owner.botId) ? 'asked' : 'proposed'
    }
    if (info?.role === 'request' || info?.role === 'reply' || info?.role === 'report' || info?.role === 'stopped') return 'delegated'
    return 'asked'
  }

  // What a Bot that wanted to send a request is told instead: `observe` recorded it,
  // `off` did not. Undefined when the request may go out.
  function proposalRefusal({ from, to, parent, text, room }) {
    if (proactive === 'auto') return undefined
    if (proactive === 'off') {
      return 'Not sent: proactive work is off for this team, so a Bot only does what the user or another Bot asked it for.'
    }
    const id = propose({ from, to, parent, text, room })
    if (id === undefined) return 'Not sent: there was nothing to record as a proposal.'
    return `Not sent: this team runs in observe mode, so a Bot does not start work on its own. What you would have sent was recorded as a proposal (${id}) and the user sees it under "Needs you", next to the work it belongs to, and can approve it there. Tell the user what you would have done and why; do not send it again.`
  }

  // The user turns an observed proposal into real work: the proposal record becomes the
  // request, so its answer comes back to the same work and no second one is opened. The
  // request is named by the proposal, so a retry — after a lost answer or a restart that
  // saved only half the change — never dispatches the same work twice.
  async function approveProposal(id) {
    const work = works()[id]
    if (work === undefined || work.proposal === undefined) return { error: 'That proposal is not waiting any more.', code: 'bot/stale' }
    if (work.from === undefined || work.to === undefined || rt.botOf(work.to) === undefined) {
      return { error: 'The Bot this proposal was for is not on the team any more.', code: 'bot/stale' }
    }
    if (work.proposal.length !== undefined) {
      return { error: `This proposal is ${work.proposal.length} characters long, more than can be sent inline, so it cannot be approved as it was. Ask the Bot to propose a shorter one.`, code: 'bot/refused' }
    }
    const identity = rt.requestIdentity({
      caller: work.from,
      context: 'approve',
      name: `approve:${id}`,
      payload: { work: id, to: work.to, text: work.proposal.text },
    })
    const seen = await rt.knownRequest(identity)
    if (seen !== undefined) {
      if (seen.status === 'replay') {
        // It went out before and the saved state did not catch up: the work is the
        // request now, so the proposal must not wait in the list a second time.
        if (work.proposal !== undefined) {
          delete work.proposal
          work.authority = 'asked'
          work.lease = { at: Date.now(), by: work.to }
          pushHistory(work, { at: Date.now(), event: 'approved' })
          save()
        }
        return { ok: true }
      }
      return { error: 'The approval may not have gone out (its outcome is not known), so it was not sent again. Check whether the Bot got it before approving again.', code: 'bot/conflict' }
    }
    const at = Date.now()
    try {
      await rt.admitRequest(identity, async () => {
        const text = `[The user approved this request]\n\n${work.proposal.text}`
        const receipt = await rt.deliver({ fromId: work.from, toId: work.to, role: 'request', exchangeId: id, text })
        // Only once it went out does the record become the request: a delivery that
        // failed leaves the proposal where the user can try again.
        delete work.proposal
        work.authority = 'asked'
        work.lease = { at, by: work.to }
        pushHistory(work, { at, event: 'approved' })
        save()
        return receipt
      })
    } catch (error) {
      rt.warn('ds-bot: approved request %s was not sent: %s', id, error)
      noteFault('delivery')
      return { error: `The request was not sent: ${error?.message ?? error}`, code: 'bot/refused' }
    }
    save()
    return { ok: true }
  }

  // A report that names something only a user can do becomes a question card in the
  // chat of the Bot that asked, so the user answers it where the work was asked for
  // instead of reading it as one more line of the answer. A card the Bot asked itself
  // wins: the user is answering something else right now. A card another report opened
  // is replaced, since the user has not seen it yet.
  function askAttention(work, name, id) {
    const report = work.report
    if (report?.humanAction === undefined || report.state === 'dropped' || report.state === 'ready') {
      rt.warn('ds-bot: no card for work %s: report %s has no user action', work.to, report?.state ?? 'missing')
      return
    }
    const chat = work.from === undefined ? undefined : rt.chatOf(work.from)
    if (chat === undefined) {
      rt.warn('ds-bot: no card for work %s: the asker %s has no chat', work.to, work.from)
      return
    }
    const open = state.questions?.[chat]
    if (open !== undefined && open.attention === undefined) {
      rt.warn('ds-bot: no card for work %s: %s already asks the user something', work.to, work.from)
      return
    }
    state.questions ??= {}
    state.questions[chat] = {
      id: randomUUID(),
      question: report.humanAction,
      detail: `${name}: ${report.summary ?? report.state}`,
      options: (report.humanOptions ?? []).map(label => ({ label })),
      allowCustom: true,
      askedAt: Date.now(),
      // The answer goes straight back to the Bot that could not go on, on the work it
      // reported on: the Bot that asked need not spend a turn to relay it, and the work
      // goes on rather than starting over as a new one.
      attention: { ownerId: work.to, askerId: work.from, work: id },
    }
  }

  // The answer to work `id` is on its way, with `result` from `name`. Returns the work
  // it goes on with. That work keeps waiting until a turn reads the answer (`taken`).
  function closeWork(id, name, text) {
    const work = works()[id]
    if (work === undefined) {
      rt.warn('ds-bot: %s answered work %s, which was not open any more', name, id)
      return undefined
    }
    rt.warn('ds-bot: closing work %s for %s: report %s, action %s, card target %s',
      id, name, work.report?.state ?? 'none', work.report?.humanAction === undefined ? 'none' : 'yes', work.from ?? 'none')
    askAttention(work, name, id)
    recordClosed(id, work, 'ready')
    delete works()[id]
    // What it still waits for comes back to it alone.
    for (const child of Object.values(works())) if (child.parent === id) delete child.parent
    const above = works()[work.parent]
    if (above !== undefined) {
      // The whole result goes into a file of its own before the team file names it.
      const file = keepResult(id, text)
      above.results.push({ id, name, text: headOf(text, TEXT_KEPT), ...(work.child ? { child: work.child } : {}), ...(text.length > TEXT_KEPT ? { length: text.length } : {}), ...(file ? { file } : {}), at: Date.now() })
      whole.set(id, text)
    }
    for (const result of work.results ?? []) whole.delete(result.id)
    // Old state can still name these files until the replacement state lands.
    // A failed save must leave them available to the next host.
    void rt.save().then(() => {
      for (const result of work.results ?? []) dropResult(result.file)
    }).catch(() => {})
    return above === undefined ? undefined : work.parent
  }
  // The subagent run a settlement notice names. The notice carries only the
  // child's id, and a child's runs end one after another, so it is the earliest
  // settled run of that child not read yet, else a run of it still out.
  const subWorkRun = (id) => {
    let settled
    let live
    for (const [workId, work] of Object.entries(works())) {
      for (const openId of work.open) {
        const result = work.results?.find(result => result.id === openId)
        if ((result?.child ?? works()[openId]?.child ?? openId) !== id) continue
        if (result === undefined) live ??= { id: openId, parent: workId }
        else if (settled === undefined || (result.at ?? 0) < settled.at) settled = { id: openId, parent: workId, at: result.at ?? 0 }
      }
    }
    return settled ?? live
  }
  // A settled run is handed back like a teammate's reply: its closing text joins
  // the results of the work it hung under. `id` is the run's id, `child` the
  // child's, which named the sub-work before runs did.
  function settleSubWork(id, text, child) {
    const key = works()[id] !== undefined ? id : child
    const work = works()[key]
    if (work === undefined) return undefined
    const { parent } = work
    closeWork(key, work.name ?? 'subagent', text)
    return parent
  }
  // A fast child can settle before its tool result identifies the call that made it.
  const nameSubWork = (id, name) => {
    const work = Object.entries(works()).find(([key, work]) => (work.child ?? key) === id)?.[1]
      ?? Object.values(works()).flatMap(work => work.results ?? []).find(result => (result.child ?? result.id) === id)
    if (work === undefined || work.name === name) return
    work.name = name
    save()
  }

  const dropWork = (id) => {
    const work = works()[id]
    if (work === undefined) return
    const { parent } = work
    recordClosed(id, work, 'dropped')
    delete works()[id]
    const above = works()[parent]
    if (above !== undefined) above.open = above.open.filter(other => other !== id)
    for (const result of work.results ?? []) whole.delete(result.id)
    void rt.save().then(() => {
      for (const result of work.results ?? []) dropResult(result.file)
    }).catch(() => {})
  }

  function taken(workId, id) {
    const work = works()[workId]
    if (work === undefined || !work.open.includes(id)) return
    work.open = work.open.filter(other => other !== id)
    save()
  }

  // A delivery the restart delayed is marked, so the answer that comes back for
  // the work says the request only arrived then.
  function lateWork(id) {
    const work = works()[id]
    if (work === undefined || work.late === true) return
    work.late = true
    save()
  }

  // The reply carrying a result never reached the asker: the failure reaches it
  // as an input instead (turns.js), which ends the wait when it is read like any
  // reply. The result kept with the work it was for is marked, so the answer
  // that goes up names it.
  function answerMissed(id) {
    noteFault('answer')
    for (const work of Object.values(works())) {
      if (!work.open.includes(id)) continue
      const result = (work.results ?? []).find(item => item.id === id)
      if (result !== undefined) result.failed = true
      save()
      return
    }
  }

  const owns = (botId, workId) => workId !== undefined && works()[workId]?.to === botId
  const waits = workId => (works()[workId]?.open.length ?? 0) > 0
  function hold(workId, text) {
    const work = works()[workId]
    if (work === undefined || text === '') return
    work.held = headOf(text, TEXT_KEPT)
    save()
  }
  // Who asked for the work, as the turn that answers a request sees its trigger.
  const askedBy = workId => {
    const work = works()[workId]
    return work === undefined ? undefined : { kind: 'bot', role: 'request', exchangeId: workId, senderSessionId: work.from, ...(work.fromRoom ? { senderRoomId: work.fromRoom } : {}) }
  }
  // The answer that goes up: what the Bot said last for this work, then what came back.
  function answerText(workId, reply, botName) {
    const work = works()[workId]
    const said = reply !== '' ? reply : work?.held ?? ''
    const results = (work?.results ?? []).map(result => {
      const { text, whole } = resultText(result)
      const cut = whole ? '' : `\n[cut; ${result.length} characters in all, the rest was not kept]`
      if (result.failed === true) return `${result.name} could not send its reply to you; what it had answered:\n${text}${cut}`
      return `${result.name}:\n${text}${cut}`
    })
    const body = results.length === 0 ? said || `${botName} finished without a reply.`
      : [said || `${botName} finished and wrote nothing more.`, `[Handed back to ${botName} for this work]`, ...results].join('\n\n')
    // What the Bot reported goes above the answer: the Bot that asked reads the outcome
    // before the detail it came with.
    const answer = [reportLine(work?.report), body].filter(Boolean).join('\n\n')
    // The request reached its target only after a restart; the answer says so.
    return work?.late === true ? `[This request reached ${botName} only after DeepSeek Harness restarted.]\n\n${answer}` : answer
  }

  // The Bots waiting for the result of these works: whoever asked for each, and on up.
  function upstreamOf(workIds) {
    const bots = new Set()
    for (const workId of workIds) {
      const seen = new Set()
      for (let id = workId; id !== undefined && !seen.has(id) && works()[id] !== undefined; id = works()[id].parent) {
        seen.add(id)
        if (works()[id].from) bots.add(works()[id].from)
      }
    }
    return bots
  }

  // Two requests from one sender belong to the same work when they were sent for it.
  const sameWork = (id, parent) => (works()[id]?.parent ?? undefined) === (works()[parent] === undefined ? undefined : parent)

  // The works their Bots wait on, outside a turn that does them (`busy`): each with what
  // it handed on that has not come back yet. One that came back waits only to be read.
  const held = busy => Object.entries(works())
    .filter(([id, work]) => work.to !== undefined && work.open.length > 0 && !busy.has(id))
    .map(([id, work]) => ({ id, work, out: work.open.map(childId => works()[childId]).filter(Boolean) }))
  const busyWith = sessionIds => new Set(sessionIds.map(sessionId => rt.live.get(sessionId)).filter(entry => entry?.turn !== undefined).map(entry => workOf(entry.info)).filter(Boolean))

  // Per Bot, the Bots and groups it waits for, and the Bots it does that work for.
  function waitingView() {
    const view = {}
    const add = (list, id) => { if (id !== undefined && !list.includes(id)) list.push(id) }
    for (const { work, out } of held(busyWith([...rt.live.keys()]))) {
      if (out.length === 0) continue
      const entry = view[work.to] ??= { bots: [], rooms: [], for: [] }
      for (const child of out) add(child.room ? entry.rooms : entry.bots, child.room ?? child.to)
      add(entry.for, work.from)
    }
    return view
  }

  // A deleted Bot answers no more work and waits for none.
  function forgetBot(botId) {
    const waiting = Object.entries(works()).filter(([, work]) => work.to === botId).map(([id]) => askedBy(id))
    for (const [id, work] of Object.entries(works())) if (work.from === botId && work.to !== botId) dropWork(id)
    return waiting
  }

  // What a Bot is doing, in one line for the Bots that work with it.
  function statusOf(botId) {
    const chat = rt.chatOf(botId)
    const sessions = [...new Set([chat, ...(rt.groupSessionsOf?.(botId) ?? [])])]
    const place = sessionId => {
      const room = rt.roomOf(rt.groupOwners.get(sessionId)?.roomId)
      return room ? `in group "${room.name}"` : 'in its own chat'
    }
    const forWhom = (sessionId, info) => {
      if (rt.groupOwners.has(sessionId)) return info?.askedBy && nameOf(info.askedBy) ? `, for ${nameOf(info.askedBy)}` : ''
      const asker = info?.role === 'request' || info?.role === 'stopped' ? info.senderSessionId : works()[workOf(info)]?.from
      if (asker !== undefined) return nameOf(asker) ? `, for ${nameOf(asker)}` : ''
      return info === undefined ? ', for the user' : ''
    }
    const doing = (entry) => {
      const what = rt.doingOf?.(entry) ?? {}
      if (what.tool) return `: running ${what.tool}${what.target ? ` on ${what.target}` : ''}`
      return what.said ? `: "${what.said.slice(0, 100)}"` : ''
    }
    const lines = []
    const approval = (rt.approvalsView?.() ?? []).find(entry => entry.botId === botId)
    const switching = [...(rt.switchJobs?.() ?? [])].find(job => job.botId === botId)
    const running = sessions.filter(sessionId => rt.live.get(sessionId)?.turn !== undefined)
    if (approval !== undefined) lines.push(`waiting for the user's approval to run ${approval.tool || 'a tool'} ${place(approval.sessionId)} (${minutes(approval.at)})`)
    else if (switching !== undefined) lines.push(`moving on to a fresh part of its ${switching.roomId ? `conversation in group "${rt.roomOf(switching.roomId)?.name ?? '?'}"` : 'own chat'}`)
    for (const sessionId of approval === undefined && switching === undefined ? running : []) {
      const entry = rt.live.get(sessionId)
      lines.push(`working ${place(sessionId)} ${minutes(entry.since ?? Date.now())}${forWhom(sessionId, entry.info)}${doing(entry)}`)
    }
    for (const { work, out } of held(busyWith(running))) {
      if (work.to !== botId) continue
      const forName = nameOf(work.from) ? `, for ${nameOf(work.from)}` : ''
      const on = [...new Set(out.map(child => (child.room ? `group "${rt.roomOf(child.room)?.name ?? 'a group'}"` : child.name ?? nameOf(child.to) ?? 'a teammate')))]
      // How long the work has waited, from the earliest piece of it still out, and what
      // came back with a report that says it could not go on.
      const since = out.reduce((earliest, child) => Math.min(earliest, child.at ?? Date.now()), Date.now())
      const stopped = out.find(child => child.report?.state === 'blocked' || child.report?.state === 'failed')
      const reported = stopped === undefined ? '' : `; it reported ${stopped.report.state}${stopped.report.summary ? `: ${stopped.report.summary}` : ''}`
      lines.push(on.length > 0 ? `waiting ${minutes(since)} for ${on.join(' and ')} to hand back work${reported}${forName}` : `about to go on with work${forName}, whose results came back`)
    }
    if (lines.length === 0) lines.push('idle')
    if (state.questions?.[chat] !== undefined) lines.push('a question card in its own chat waits for the user\'s answer')
    if (state.views?.[chat] !== undefined) lines.push('a view card in its own chat waits for the user\'s answer')
    const unread = new Map()
    for (const args of rt.unreadOf?.(chat) ?? []) {
      const name = nameOf(args.fromId)
      if (name !== undefined) unread.set(name, (unread.get(name) ?? 0) + 1)
    }
    if (unread.size > 0) lines.push(`not read yet: ${[...unread].map(([name, count]) => `${count} from ${name}`).join(', ')}`)
    return lines.join('; ')
  }

  // A report the Bot that answers a work makes about it: what it concluded, and what a
  // user would have to do. The state is the Bot's judgement; the work itself stays the
  // fact, so a report never closes it — the answer that ends the turn does.
  function reportOn(id, input) {
    const work = works()[id]
    if (work === undefined) return { error: 'This turn is not answering a request, so there is no work to report on.' }
    const { report, error } = normalizeReport(input)
    if (error !== undefined) return { error }
    if (report.state === 'progress') {
      work.progress = report
      // The stalled mark is the host's guess; the owner reporting progress replaces it.
      if (work.report?.stalled === true) delete work.report
    } else work.report = report
    // A report is the owner saying it is still there: the lease moves with it, and a
    // later silence is a new stall that is worth reporting again.
    work.lease = { at: report.at, by: work.to }
    delete work.stalled
    pushHistory(work, { at: report.at, event: report.state, ...(report.summary === undefined ? {} : { summary: report.summary }) })
    save()
    return { report }
  }

  // The state of one work by id, for the tools and the panel.
  const workState = id => workStateOf(works()[id])

  // Runs a turn in any Bot right now. Used to keep the team from fanning out into
  // more parallel work than it can carry: a user's message always gets through.
  const activeTurns = () => [...rt.live.values()].filter(entry => entry?.turn !== undefined).length

  // How the team's work has gone so far, read from the log of closed works and the
  // open ones. Read-only: a panel may ask as often as it polls.
  function workStats() {
    const closed = state.workLog ?? []
    const byFinal = {}
    let ms = 0
    let timed = 0
    let turns = 0
    for (const entry of closed) {
      byFinal[entry.final] = (byFinal[entry.final] ?? 0) + 1
      turns += entry.turns ?? 0
      if (entry.ms !== undefined) {
        ms += entry.ms
        timed += 1
      }
    }
    return {
      closed: closed.length,
      open: Object.keys(works()).length,
      byFinal,
      turns,
      ...(timed === 0 ? {} : { avgMs: Math.round(ms / timed) }),
    }
  }

  // The key a panel sends back to ignore one item: what it is, and which one, so that
  // ignoring a work does not hide the next state the same work comes back in.
  const needKey = item => (item.kind === 'answer' ? `answer:${item.questionId}` : `${item.kind}:${item.work}`)

  // Whether the system is well right now: the work that stopped reporting, and the
  // deliveries and answers that failed in the last hour. Nothing here when it is well.
  function workHealth() {
    const faults = state.workFaults ?? {}
    const now = Date.now()
    const recent = kind => (faults[kind] ?? []).filter(at => now - at < HEALTH_WINDOW_MS).length
    return {
      stalled: Object.values(works()).filter(work => work.stalled !== undefined || work.report?.stalled === true).length,
      deliveryFailures: recent('delivery'),
      answerFailures: recent('answer'),
    }
  }

  // Everything that waits for the user, in one list: the question cards the team has
  // open, and the work that came back blocked, failed, ready to review or proposed. It
  // is what a panel or a summary needs to answer "does anything need me now".
  const needsYou = () => {
    const items = []
    const botOfChat = (sessionId) => {
      const known = rt.selfOf?.(sessionId)
      if (known !== undefined) return known
      return Object.keys(state.bots).find(botId => rt.chatOf(botId) === sessionId)
    }
    for (const [sessionId, question] of Object.entries(state.questions ?? {})) {
      const botId = botOfChat(sessionId)
      items.push({
        kind: 'answer',
        botId,
        bot: rt.botOf(botId)?.name,
        sessionId,
        questionId: question.id,
        question: question.question,
        since: question.askedAt,
        allowCustom: question.allowCustom !== false,
        ...(question.options?.length > 0 ? { options: question.options.map(option => ({ label: option.label })) } : {}),
        ...(question.detail === undefined ? {} : { detail: question.detail }),
      })
    }
    for (const [id, work] of Object.entries(works())) {
      const workStateValue = workStateOf(work)
      if (!waitsForUser(workStateValue.state)) continue
      const kind = workStateValue.state === 'person/review' ? 'review'
        : workStateValue.state === 'person/proposed' ? 'proposed'
          : 'blocked'
      // The row opens the Bot that is blocked, not the one that asked: opening the
      // asker's chat lands on the chat the user is already reading. A proposal has no
      // blocked Bot, so it opens the one that would have done it.
      const owner = work.proposal === undefined ? work.to ?? work.from : work.from
      items.push({
        kind,
        botId: owner,
        bot: rt.botOf(owner)?.name,
        sessionId: rt.chatOf(owner),
        ...(work.proposal !== undefined || rt.botOf(work.from)?.name === undefined ? {} : { askedBy: rt.botOf(work.from)?.name }),
        work: id,
        since: workStateValue.since,
        ...(workStateValue.summary === undefined ? {} : { summary: workStateValue.summary }),
        ...(work.proposal !== undefined ? { proposed: true, to: rt.botOf(work.to)?.name, summary: work.proposal.summary ?? work.proposal.text } : {}),
        history: work.history ?? [],
      })
    }
    // What the user ignored stays hidden until that work or question moves on: an item
    // whose state began after the dismissal is news again.
    const dismissed = state.dismissed ?? {}
    return items
      .map(item => ({ ...item, key: needKey(item) }))
      .filter((item) => {
        const at = dismissed[item.key]
        return at === undefined || at < (item.since ?? 0)
      })
      .sort((left, right) => (left.since ?? 0) - (right.since ?? 0))
  }

  // The user does not want to act on these: an ignored proposal is dropped for good,
  // and a work that is still open is only hidden from the list.
  function dismissNeeds(keys) {
    const at = Date.now()
    const dismissed = (state.dismissed ??= {})
    let dropped = 0
    for (const key of keys) {
      const colon = key.indexOf(':')
      const kind = key.slice(0, colon)
      const id = key.slice(colon + 1)
      if (colon < 1 || id === '' || !['answer', 'blocked', 'review', 'proposed'].includes(kind)) continue
      dismissed[key] = at
      if (kind === 'proposed' && works()[id] !== undefined) {
        dropWork(id)
        dropped += 1
      }
    }
    // One entry per ignored item: the oldest go first, so the map cannot grow forever.
    const entries = Object.entries(dismissed)
    if (entries.length > 400) {
      entries.sort((left, right) => left[1] - right[1])
      for (const [key] of entries.slice(0, entries.length - 400)) delete dismissed[key]
    }
    save()
    return { dismissed: keys.length, dropped }
  }

  // How long the work went without a word, the same way the report says it.
  const silenceOf = (work, report) => {
    const since = work.progress?.at ?? work.lease?.at ?? work.at ?? report.at
    return Math.max(1, Math.round((report.at - since) / 60_000))
  }

  // The Bot that asked hears that the work it waits for stopped reporting. The input
  // waits in its own chat for its next turn, so it can do the work itself, hand it on,
  // or tell the user; no model call is spent on a Bot that is not running.
  async function notifyStall(work, report) {
    if (work.from === undefined || work.to === undefined || rt.botOf(work.from) === undefined) return
    const min = silenceOf(work, report)
    const text = `The work you handed on to ${nameOf(work.to)} did not report for ${min} min, so it is marked stalled. It may still be running. Decide what to do with it: do it yourself, hand it to another Bot, or tell the user. If it answers, its answer still reaches you.`
    await rt.deliver({ fromId: work.to, toId: work.from, role: 'stalled', text })
  }

  // The stalled task goes back to the Bot that held it, under the same work. The
  // request is named by the work, so a sweep that runs again — in this run or after a
  // restart, with or without the stall mark — finds its receipt and never runs the
  // task a second time.
  async function redispatch(id, work, report) {
    if (work.from === undefined || work.to === undefined || rt.botOf(work.to) === undefined) return
    const exchange = (state.exchanges ?? []).find(item => item.id === id && item.role === 'request')
    if (exchange === undefined) return
    const request = await rt.exchangeText(exchange)
    if (request === undefined || !request.whole || String(request.text ?? '').trim() === '') return
    const identity = rt.requestIdentity({
      caller: work.from,
      context: 'lease',
      name: `stall:${id}`,
      payload: { work: id, text: request.text },
    })
    if (await rt.knownRequest(identity) !== undefined) return
    await rt.admitRequest(identity, () => {
      const min = silenceOf(work, report)
      const text = `[${nameOf(work.to)} stopped reporting on this work for ${min} min, so it is handed to you again]\n\n${request.text}`
      return rt.deliver({ fromId: work.from, toId: work.to, role: 'request', exchangeId: id, text })
    })
  }

  const actOnStall = async (id, work, report) => {
    await notifyStall(work, report)
    if (leasePolicy.action === 'redispatch') await redispatch(id, work, report)
  }

  // Work that stopped reporting is marked stale and acted on, so the Bot that asked
  // reads why it still waits instead of waiting forever. A stall is acted on once: the
  // mark stays until the owner reports again, so a sweep that runs every minute cannot
  // send the same notice twice.
  const sweepStalled = (at = Date.now()) => {
    let changed = false
    for (const [id, work] of Object.entries(works())) {
      if (work.stalled !== undefined) continue
      const report = stalledReport(work, at, leasePolicy.deadline)
      if (report === undefined) continue
      work.report = report
      work.stalled = { at, action: leasePolicy.action }
      pushHistory(work, { at, event: 'stalled', ...(report.reason === undefined ? {} : { reason: report.reason }) })
      changed = true
      void actOnStall(id, work, report).catch((error) => {
        // It was not told, so the next sweep tries again rather than swallowing the stall.
        rt.warn('ds-bot: the stall of work %s was not reported: %s', id, error)
        delete work.stalled
        noteFault('delivery')
        save()
      })
    }
    if (changed) save()
    return changed
  }
  rt.ctx?.effect?.(() => {
    const timer = setInterval(() => sweepStalled(), 60_000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'ds-bot: mark work that stopped reporting')

  Object.assign(rt, { workOf, openWork, closeWork, dropWork, takenWork: taken, lateWork, answerMissed, ownsWork: owns, waitsWork: waits, holdWork: hold, reportWork: reportOn, sweepStalled, leasePolicy, proactive, proposeWork: propose, workAuthorityOf, proposalRefusal, approveProposal, noteWorkTurn, noteFault, workStats, workHistory, workHealth, activeTurns, needsYou, dismissNeeds, workState, workStateOf, workAsker: askedBy, answerText, upstreamOf, sameWork, forgetBotWork: forgetBot, statusOf, waitingView, settleSubWork, subWorkRun, nameSubWork })
}
