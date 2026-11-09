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
import { MESSAGE_INLINE_MAX, STEER_CUT, TEXT_KEPT, WORK_LOG_MAX } from './constants.js'
import { headOf } from './text.js'
import { etaDeviation, etaView, jobInProgress, leasePolicyOf, normalizeReport, parseEta, proactiveOf, reportLine, resumeOpen, resumePolicyOf, stalledReport, waitsForUser, workStateOf } from './work-state.js'

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
  // Whether a reply carries its whole text to the Bot that asked, or only the report
  // line and a pointer to the file where the whole reply is kept.
  const replyMode = rt.config?.replyDetail === 'full' ? 'full' : 'summary'
  // One work keeps this many replies; the newest are the ones worth reading.
  const REPLY_KEEP = 5

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
      // The estimate it carried, whether the team reminded its owner, and how it ended:
      // the three facts a later question about an overrun needs.
      ...(work.eta === undefined ? {} : { eta: { minutes: work.eta.minutes, text: work.eta.text, reminded: work.eta.reminded ?? [], ...(work.escalation === undefined ? {} : { escalation: { kind: work.escalation.kind, to: work.escalation.to, temporary: work.escalation.temporary === true, restored: work.escalation.restored === true } }) } }),
      // How often the host had to nudge the owner along, and whether it gave up.
      ...(work.resume === undefined ? {} : { resume: { attempts: work.resume.attempts ?? 0, ...(work.resume.gaveUp === true ? { gaveUp: true } : {}) } }),
      ...(work.escalation === undefined ? {} : { escalated: true }),
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
  const DAY_MS = 24 * 60 * 60_000
  const FAULT_KINDS = ['delivery', 'answer']
  function noteFault(kind) {
    if (!FAULT_KINDS.includes(kind)) return
    const faults = (state.workFaults ??= {})
    const list = (faults[kind] ??= [])
    list.push(Date.now())
    if (list.length > 50) list.splice(0, list.length - 50)
    save()
  }

  // The whole reply of a work in a file of its own, so the Bot that asked reads the
  // report line and opens the file only when the detail matters. Undefined when the
  // file cannot be written, and then the reply goes whole: an answer is never lost.
  function keepReply(workId, text) {
    if (!writes() || workId === undefined) return undefined
    const work = works()[workId]
    const count = (work?.replies ?? 0) + 1
    const dir = join(rt.home, 'works', resultName(workId))
    const path = join(dir, `reply-${count}.md`)
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path, text, 'utf8')
      if (work !== undefined) work.replies = count
      if (count > REPLY_KEEP) rmSync(join(dir, `reply-${count - REPLY_KEEP}.md`), { force: true })
      return path
    } catch (error) {
      rt.warn('ds-bot: reply of work %s not kept whole: %s', workId, error)
      return undefined
    }
  }

  // What the Bot that asked reads: what the Bot concluded, what only a user can give,
  // and where the whole reply is. `replyDetail: 'full'` puts the text back inline.
  function replyDelivery(workId, text) {
    if (replyMode === 'full') return { text, slim: false }
    const work = works()[workId]
    if (work === undefined) return { text, slim: false }
    const kept = keepReply(workId, text)
    if (kept === undefined) return { text, slim: false }
    const head = work.report === undefined ? '[ready]' : reportLine(work.report)
    // A line the reply addressed to the user is the one thing only the user can do: it
    // is short and it must survive the slim version.
    const needs = text.split('\n').map(line => line.trim()).filter(line => /^needs the user:/i.test(line)).slice(0, 3)
    return {
      text: [head, ...needs, `[Full reply: ${kept}]`, 'Read that file when the detail matters; the user does not need it repeated.'].join('\n'),
      slim: true,
      detail: kept,
    }
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
  function openWork(id, { from, to, parent, fromRoom, room, name, child, authority, eta }) {
    const above = parent === undefined ? undefined : works()[parent]
    const at = Date.now()
    // The estimate of how long it takes is optional: a hand-off without one works, and
    // the panel says "no estimate" instead of comparing it to anything.
    const estimate = parseEta(eta)
    works()[id] = { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(room ? { room } : {}), ...(above ? { parent } : {}), ...(fromRoom ? { fromRoom } : {}), ...(name ? { name } : {}), ...(child ? { child } : {}), ...(estimate ? { eta: { ...estimate, at } } : {}), authority: authority ?? 'delegated', lease: { at, by: to }, open: [], results: [], at, history: [{ at, event: 'created', authority: authority ?? 'delegated' }] }
    if (above !== undefined) above.open.push(id)
    save()
  }

  // Work a Bot starts on its own: under `observe` it is only recorded, so the user
  // reads what the Bot would have done next to the work it belongs to, and nothing is
  // sent; `off` refuses it above. A proposal is never put in its parent's `open`: the
  // Bot that asked waits for the results it actually handed on, not for this.
  function propose({ from, to, parent, text, room, reason }) {
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
      proposal: { at, text: whole, summary: kept, ...(String(reason ?? '').trim() === '' ? {} : { reason: headOf(String(reason).replace(/\s+/g, ' ').trim(), 300) }), ...(work.length > MESSAGE_INLINE_MAX ? { length: work.length } : {}) },
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

  // A Bot that sees a concrete piece of work in a group round nobody named it in records
  // it instead of doing it: that is what observe mode is for. Anywhere else it is not a
  // proposal — the user or another Bot asked, so the Bot acts.
  function recordProposal(exec, input = {}) {
    const sessionId = exec.agent?.id
    const turn = rt.live.get(sessionId)
    const info = turn?.info
    if (info?.role !== 'room') return { error: 'A proposal is only for a group round nobody named you in. Here, do the work or say what you would do.' }
    if (proactive === 'off') return { error: 'Proactive work is off for this team, so a Bot does not propose work on its own.' }
    if (info.askedBy !== undefined || info.namedByUser === true) return { error: 'This round called you, so the work is yours to do: do it, or hand it on with post_to_group.' }
    const from = rt.selfOf?.(sessionId) ?? rt.groupOwners?.get(sessionId)?.botId
    if (from === undefined) return { error: 'Only a Bot on the team can propose work.' }
    const room = info.roomId === undefined ? undefined : rt.roomOf(info.roomId)
    if (room !== undefined && rt.isAdminOf?.(room, from)) return { error: 'You lead this round, so decide and hand the work on with post_to_group; a proposal is for a member the round did not call.' }
    if ((turn.proposed ?? 0) >= 1) return { error: 'One proposal per turn: keep the one worth the user\'s attention.' }
    const title = String(input.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
    if (title === '') return { error: 'Write a short title for the work you would do.' }
    const id = propose({ from, to: from, text: title, reason: input.reason, room: info.roomId })
    if (id === undefined) return { error: 'There was nothing to record.' }
    turn.proposed = (turn.proposed ?? 0) + 1
    return { id }
  }

  // A proposal that is settled without becoming a hand-off: recorded, then gone. Its
  // final state says what became of it rather than pretending it was answered.
  function settleProposal(id, work, final) {
    recordClosed(id, work, final)
    delete works()[id]
    save()
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
          if (work.from === work.to) settleProposal(id, work, 'approved')
          else {
            delete work.proposal
            work.authority = 'asked'
            work.lease = { at: Date.now(), by: work.to }
            pushHistory(work, { at: Date.now(), event: 'approved' })
            save()
          }
        }
        return { ok: true }
      }
      return { error: 'The approval may not have gone out (its outcome is not known), so it was not sent again. Check whether the Bot got it before approving again.', code: 'bot/conflict' }
    }
    const at = Date.now()
    try {
      await rt.admitRequest(identity, async () => {
        const approved = `[The user approved this request]\n\n${work.proposal.text}${work.proposal.reason === undefined ? '' : `\n\nWhy: ${work.proposal.reason}`}`
        // A Bot that offered the work itself needs no request: the user's approval is
        // the message, in the chat where the work already lives.
        if (work.from === work.to) {
          await rt.ensureCapabilities?.(rt.chatOf(work.to))
          await rt.ctx.sessionController.prompt({
            requestId: randomUUID(),
            sessionId: rt.chatOf(work.to),
            mode: 'queue',
            content: [{ type: 'text', text: approved }],
          }, AbortSignal.timeout(30_000))
          settleProposal(id, work, 'approved')
          return id
        }
        const receipt = await rt.deliver({ fromId: work.from, toId: work.to, role: 'request', exchangeId: id, text: approved })
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
    restoreEscalation(id, work)
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
    restoreEscalation(id, work)
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
  function reportOn(id, input, exec) {
    const work = works()[id]
    if (work === undefined) return { error: 'This turn is not answering a request, so there is no work to report on.' }
    const { report, error } = normalizeReport(input)
    if (error !== undefined) return { error }
    // A ready report is not final while the Bot still has a background job of this very
    // turn running: the answer cannot be read yet, and its end is the only thing that
    // would bring the Bot back. The report is held and the work stays open.
    const sessionId = exec?.agent?.id
    const running = report.state === 'ready' && sessionId !== undefined
      ? (rt.liveJobsOf?.(work.to) ?? []).filter(job => job.sessionId === sessionId
        && job.turn !== undefined && job.turn === rt.live?.get(sessionId)?.turn)
      : []
    if (running.length > 0) {
      work.heldReport = report
      work.awaitingJobs = running.map(job => job.id)
      work.report = { state: 'progress', summary: 'waiting for its background job to finish', at: report.at }
      work.lease = { at: report.at, by: work.to }
      delete work.stalled
      pushHistory(work, { at: report.at, event: 'held', jobs: work.awaitingJobs })
      save()
      return { report: work.report, held: running.map(job => job.id) }
    }
    // A work that goes on into another Bot's work does not end here: its report has to
    // say what happens next and who does it, or it reads as finished and the chain stops.
    const chained = work.parent !== undefined && works()[work.parent] !== undefined
    if (chained && (report.state === 'ready' || report.state === 'blocked') && report.next === undefined) {
      return { error: 'This work goes on into another Bot\'s work, so its report has to say the next step: call report again with next — what happens next and who does it. Without a next step it does not count as finished.' }
    }
    if (report.state === 'progress') {
      work.progress = report
      // The stalled mark is the host's guess; the owner reporting progress replaces it.
      if (work.report?.stalled === true) delete work.report
    } else work.report = report
    // A report is the owner saying it is still there: the lease moves with it, and a
    // later silence is a new stall that is worth reporting again. A stop the user asked
    // for is answered the same way: the owner speaking again lifts it.
    work.lease = { at: report.at, by: work.to }
    delete work.stalled
    delete work.halted
    // The attempt counter belongs to the stretch between reports: a work that reported
    // progress starts the nudge budget again.
    if (report.state === 'progress') delete work.resume
    pushHistory(work, { at: report.at, event: report.state, ...(report.summary === undefined ? {} : { summary: report.summary }) })
    save()
    return { report }
  }

  // A held work whose last background job has ended: deliver one notice naming the job
  // and where its output is, so the Bot reads the result and reports again. It never
  // re-sends a message that is already waiting; the notice itself is the news.
  function flushWake(id) {
    const work = works()[id]
    const wake = work?.wake
    if (wake === undefined) return false
    const label = typeof wake.label === 'string' && wake.label !== '' ? ` (${wake.label.slice(0, 120)})` : ''
    const files = Array.isArray(wake.spillPaths) && wake.spillPaths.length > 0 ? `\nOutput files: ${wake.spillPaths.join(', ')}` : ''
    const text = `[background job ${wake.jobId}${label} finished]\nIt is the job you left running on this work. Read its result with job_output, then report this work again.${files}`
    let sent = false
    try {
      sent = rt.wakeJobNotice?.(wake.sessionId, wake.jobId, text) === true
    } catch (error) {
      rt.warn('ds-bot: the job %s end was not announced for work %s: %s', wake.jobId, id, error)
      return false
    }
    // No Session to wake yet: keep the wake for the sweep instead of losing it.
    if (!sent) return false
    delete work.wake
    save()
    return true
  }

  // Job lifecycle from steer.js: a work held for its Bot's background job keeps waiting
  // until the last of those jobs has ended; then one wake is queued.
  function jobEnded(job) {
    if (job?.id === undefined) return
    const botId = rt.selfOf?.(job.sessionId)
    let changed = false
    for (const work of Object.values(works())) {
      if (botId !== undefined && work.to !== botId) continue
      if (!Array.isArray(work.awaitingJobs) || !work.awaitingJobs.includes(job.id)) continue
      work.awaitingJobs = work.awaitingJobs.filter(other => other !== job.id)
      changed = true
      if (work.awaitingJobs.length > 0) continue
      delete work.awaitingJobs
      work.wake = {
        jobId: job.id,
        sessionId: job.sessionId,
        ...(typeof job.label === 'string' ? { label: job.label } : {}),
        ...(Array.isArray(job.spillPaths) && job.spillPaths.length > 0 ? { spillPaths: job.spillPaths } : {}),
        at: Date.now(),
      }
      pushHistory(work, { at: Date.now(), event: 'job-ended', jobId: job.id })
      delete work.heldReport
    }
    if (changed) save()
    for (const [id, work] of Object.entries(works())) if (work.wake !== undefined) flushWake(id)
  }

  // The state of one work by id, for the tools and the panel.
  const workState = id => workStateOf(works()[id])

  // Runs a turn in any Bot right now. Used to keep the team from fanning out into
  // more parallel work than it can carry: a user's message always gets through.
  const activeTurns = () => [...rt.live.values()].filter(entry => entry?.turn !== undefined).length

  // How the team's work has gone so far, read from the log of closed works and the
  // open ones. Read-only: a panel may ask as often as it polls.
  function workStats(at = Date.now()) {
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
    // The summary the panel shows, for the last day only: a team that did nothing worth
    // reporting today stays quiet instead of showing a lifetime total.
    const since = at - DAY_MS
    const today = closed.filter(entry => (entry.closedAt ?? 0) >= since)
    const durations = today.map(entry => entry.ms).filter(length => length !== undefined).sort((left, right) => left - right)
    const middle = Math.floor(durations.length / 2)
    const medianMs = durations.length === 0 ? undefined
      : durations.length % 2 === 1 ? durations[middle] : Math.round((durations[middle - 1] + durations[middle]) / 2)
    const faults = state.workFaults ?? {}
    const failed = kind => (faults[kind] ?? []).filter(time => at - time < DAY_MS).length
    const stalled = Object.values(works()).filter(stalledWork).length
      + today.filter(entry => (entry.history ?? []).some(event => event.event === 'stalled')).length
    return {
      closed: closed.length,
      open: Object.keys(works()).length,
      byFinal,
      turns,
      ...(timed === 0 ? {} : { avgMs: Math.round(ms / timed) }),
      day: {
        closed: today.length,
        ...(medianMs === undefined ? {} : { medianMs }),
        stalled,
        deliveryFailures: failed('delivery'),
        answerFailures: failed('answer'),
      },
    }
  }

  // The key a panel sends back to ignore one item: what it is, and which one, so that
  // ignoring a work does not hide the next state the same work comes back in.
  const needKey = item => (item.kind === 'answer' ? `answer:${item.questionId}` : item.kind === 'approval' ? `approval:${item.sessionId}` : `${item.kind}:${item.work}`)

  // The row a work appears under: the kind, and the moment its current state began. The
  // inbox and the health line both read it, so a row the user dismissed is not news in
  // either place.
  const workRowOf = (work) => {
    const value = workStateOf(work)
    return {
      ...value,
      kind: value.state === 'person/review' ? 'review' : value.state === 'person/proposed' ? 'proposed' : 'blocked',
    }
  }
  // Hidden while the dismissal is at least as new as the state the row shows: a work
  // that moves on after the user dismissed it is news again.
  const dismissedAt = (key, since) => {
    const at = (state.dismissed ?? {})[key]
    return at !== undefined && at >= (since ?? 0)
  }
  // The host's own mark that a work stopped reporting, as opposed to the owner's report.
  const stalledWork = work => work.stalled !== undefined || work.report?.stalled === true

  // Whether the system is well right now: the work that stopped reporting, and the
  // deliveries and answers that failed in the last hour. Nothing here when it is well.
  function workHealth() {
    const faults = state.workFaults ?? {}
    const now = Date.now()
    const recent = kind => (faults[kind] ?? []).filter(at => now - at < HEALTH_WINDOW_MS).length
    // A stall the user dismissed is not news, exactly as its row is not in the inbox.
    const stalled = Object.entries(works()).filter(([id, work]) => {
      if (!stalledWork(work)) return false
      const row = workRowOf(work)
      return !dismissedAt(`${row.kind}:${id}`, row.since)
    }).length
    // Model calls the team had to retry, and those that still ended failed.
    const retry = rt.llmRetryView?.(now) ?? { retries: 0, retryFailures: 0 }
    return { stalled, deliveryFailures: recent('delivery'), answerFailures: recent('answer'), retries: retry.retries, retryFailures: retry.retryFailures }
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
      const row = workRowOf(work)
      if (!waitsForUser(row.state)) continue
      // The row opens the Bot that is blocked, not the one that asked: opening the
      // asker's chat lands on the chat the user is already reading. A proposal has no
      // blocked Bot, so it opens the one that would have done it.
      const owner = work.proposal === undefined ? work.to ?? work.from : work.from
      items.push({
        kind: row.kind,
        botId: owner,
        bot: rt.botOf(owner)?.name,
        sessionId: rt.chatOf(owner),
        ...(work.proposal !== undefined || rt.botOf(work.from)?.name === undefined ? {} : { askedBy: rt.botOf(work.from)?.name }),
        work: id,
        since: row.since,
        ...(row.summary === undefined ? {} : { summary: row.summary }),
        ...(work.proposal !== undefined ? { proposed: true, ...(work.to === work.from ? {} : { to: rt.botOf(work.to)?.name }), summary: work.proposal.summary ?? work.proposal.text } : {}),
        history: work.history ?? [],
      })
    }
    // Approvals the policy could not decide wait here too, with the reason it could not:
    // one row per conversation, however many requests that Bot has open.
    for (const approval of rt.approvalNeeds?.() ?? []) items.push(approval)
    return items
      .map(item => ({ ...item, key: needKey(item) }))
      .filter(item => !dismissedAt(item.key, item.since))
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
      const work = works()[id]
      if (work === undefined) continue
      // An ignored proposal is gone for good, and so is a work that was already stalled:
      // nothing waits on it any more once the user says so, so it should not sit in the
      // team file for good. A work that is still running, or one that handed on work of
      // its own, is only hidden: only the row goes away.
      const stalled = stalledWork(work)
      if (kind === 'proposed' || (kind === 'blocked' && stalled && (work.open ?? []).length === 0)) {
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
    // A chain the host nudged for ever is a different fact from a silent lease: the Bot
    // was asked to continue and did not.
    const text = report.reason === 'no_continue'
      ? `The work you handed on to ${nameOf(work.to)} is still open after ${report.attempts ?? 'a few'} continue attempts, so it is marked stalled. Decide what to do with it: nudge it again, take it over, or hand it to another Bot. If it answers, its answer still reaches you.`
      : `The work you handed on to ${nameOf(work.to)} did not report for ${min} min, so it is marked stalled. It may still be running. Decide what to do with it: do it yourself, hand it to another Bot, or tell the user. If it answers, its answer still reaches you.`
    await rt.deliver({ fromId: work.to, toId: work.from, role: 'stalled', text })
  }

  // --- The estimate a hand-off carried, and the ladder out of an overrun ------------
  //
  // A work running past its estimate is the team's own problem, not the user's: at 80%
  // and again at 150% the Bot that handed it on is told, with the next rung spelled
  // out, and it acts. The ladder goes up, not sideways — a higher thinking level on the
  // same model, then a stronger model, then a dedicated Bot for the blocker. Moving the
  // work to another Bot of the same kind is the last resort, for a polluted context.
  // Nothing here asks the user to decide.

  const ETA_AUDIT_MAX = 200
  const etaAuditLog = () => (state.etaAudit ??= [])
  function recordEta(entry) {
    etaAuditLog().push({ at: Date.now(), ...entry })
    if (etaAuditLog().length > ETA_AUDIT_MAX) etaAuditLog().splice(0, etaAuditLog().length - ETA_AUDIT_MAX)
    save()
  }

  // Reminders delivered and not acted on yet, per Bot that handed the work on. Only the
  // latest few matter, and only within this run: the mark on the work is the durable part.
  const etaPending = new Map()
  function pendEta(sessionId, entry) {
    const list = etaPending.get(sessionId) ?? []
    list.push(entry)
    if (list.length > 5) list.splice(0, list.length - 5)
    etaPending.set(sessionId, list)
  }

  // The next rung for a Bot that is behind: a higher thinking level on its model, a
  // stronger model, or a dedicated Bot when the catalog offers nothing better.
  async function escalationAdvice(work) {
    const bot = rt.botOf(work?.to)
    if (bot === undefined) return { kind: 'unknown' }
    const ref = bot.model ?? bot.appliedModel
    const reasoning = ref === undefined ? undefined : await Promise.resolve(rt.reasoningOf?.(ref)).catch(() => undefined)
    const efforts = reasoning?.efforts ?? []
    const current = bot.effort ?? reasoning?.defaultEffort
    const at = efforts.findIndex(effort => effort.id === current)
    const next = at < 0 ? efforts[efforts.length - 1] : efforts[at + 1]
    if (next !== undefined && next.id !== current) return { kind: 'effort', bot: bot.name, botId: bot.id, from: current, to: next.id }
    const models = (await Promise.resolve(rt.catalog?.() ?? []).catch(() => []))
      .map(entry => entry.ref)
      .filter(model => model !== bot.model)
    if (models.length > 0) return { kind: 'model', bot: bot.name, botId: bot.id, options: models.slice(0, 5), to: models[0] }
    return { kind: 'new-bot', bot: bot.name, botId: bot.id }
  }

  // The next step, in words the Bot that handed the work on can act on with one call.
  function adviceText(advice) {
    if (advice.kind === 'effort') {
      return `raise ${advice.bot}'s thinking level to ${advice.to} (update_bot bot "${advice.bot}" effort "${advice.to}" temporary true), and let it carry on rather than repeating steps it already finished`
    }
    if (advice.kind === 'model') {
      return `move ${advice.bot} to a stronger model such as ${advice.to} (update_bot bot "${advice.bot}" model "${advice.to}" temporary true); it goes back to its own model when the work ends`
    }
    if (advice.kind === 'new-bot') {
      return `create one dedicated high-spec Bot for this blocker (create_bot, with a diagnosis of what was tried, what the errors were and what is already ruled out) and let it hand the conclusion back to ${advice.bot}`
    }
    return 'check what it is doing and decide: raise its effort or model with update_bot, or take the blocked step yourself'
  }

  async function notifyEta(id, work, deviation) {
    if (work.from === undefined || work.to === undefined || rt.botOf(work.from) === undefined) return
    const advice = await escalationAdvice(work)
    const estimate = Math.max(1, Math.round(deviation.minutes))
    const spent = Math.max(1, Math.round(deviation.elapsedMs / 60_000))
    const suggest = adviceText(advice)
    const text = deviation.stage === 1
      ? `The work you handed to ${nameOf(work.to)} was estimated at ${estimate} min and ${spent} min have passed with no result. Act now rather than passing the decision on: ${suggest}. Only if that step needs a credential, money or an outside account, tell the user what you tried, where it is stuck and the one thing they must do.`
      : `The work you handed to ${nameOf(work.to)} is 50% past its estimate (${spent} min of ${estimate} min) and still has no result. Act now: ${suggest}. If the blocker is the Bot's context rather than the task, start a fresh Bot with the diagnosis of what was tried and let it hand the conclusion back. Do not simply move the work to another Bot of the same kind, and do not ask the user unless the step itself needs them.`
    await rt.deliver({ fromId: work.to, toId: work.from, role: deviation.stage === 1 ? 'eta' : 'eta-late', text })
    // The reminder lands in the asker's own chat, so that is the session its action comes from.
    const sessionId = rt.chatOf(work.from)
    if (sessionId !== undefined) pendEta(sessionId, { work: id, stage: deviation.stage, at: Date.now() })
  }

  // Time only: the estimate is compared with the clock, and what the work is doing is
  // the owner's report, not this check.
  function sweepEta(at) {
    let changed = false
    for (const [id, work] of Object.entries(works())) {
      const deviation = etaDeviation(work, at)
      if (deviation === undefined) continue
      const stages = deviation.stage === 2 ? [1, 2] : [1]
      work.eta.reminded = [...new Set([...(work.eta.reminded ?? []), ...stages])].sort((left, right) => left - right)
      pushHistory(work, { at, event: deviation.stage === 1 ? 'eta' : 'eta-late', minutes: work.eta.minutes, elapsed: Math.max(1, Math.round(deviation.elapsedMs / 60_000)) })
      recordEta({ work: id, kind: deviation.stage === 1 ? 'due' : 'late', minutes: work.eta.minutes, elapsedMs: deviation.elapsedMs, bot: nameOf(work.to) })
      changed = true
      void notifyEta(id, work, deviation).catch((error) => {
        // It was not told, so the next sweep tries again rather than swallowing it.
        rt.warn('ds-bot: the estimate of work %s was not checked with its owner: %s', id, error)
        work.eta.reminded = (work.eta.reminded ?? []).filter(stage => stage !== deviation.stage)
        noteFault('delivery')
        save()
      })
    }
    return changed
  }

  // What the Bot that handed the work on did about a reminder, kept for the audit: the
  // rung it took, and whether it went sideways instead of up. A second action soon after
  // — stop the Bot, then hand the work to someone else — is the same story, so it is
  // recorded against the same work as a follow-up rather than as an unrelated move.
  const ETA_FOLLOW_MS = 10 * 60_000
  function noteEtaAction(sessionId, action = {}) {
    const list = etaPending.get(sessionId)
    if (list === undefined || list.length === 0) return undefined
    const now = Date.now()
    // A reminder acted on long ago is not the one this action answers.
    for (let at = list.length - 1; at >= 0; at--) {
      if (list[at].actedAt !== undefined && now - list[at].actedAt > ETA_FOLLOW_MS) list.splice(at, 1)
    }
    if (list.length === 0) {
      etaPending.delete(sessionId)
      return undefined
    }
    const target = action.target
    let index = target === undefined ? list.length - 1 : list.findIndex(entry => nameOf(works()[entry.work]?.to) === target)
    if (index < 0) index = list.length - 1
    const pending = list[index]
    const followUp = pending.actedAt !== undefined
    // The first action keeps the reminder pending for one follow-up; that follow-up
    // closes it. Nothing else is attributed to it.
    if (!followUp) pending.actedAt = now
    else list.splice(index, 1)
    if (list.length === 0) etaPending.delete(sessionId)
    const work = works()[pending.work]
    const holder = nameOf(work?.to)
    const kind = action.kind ?? 'other'
    const record = {
      work: pending.work,
      stage: pending.stage,
      kind,
      ...(followUp ? { followUp: true, after: pending.firstKind } : {}),
      ...(action.target === undefined ? {} : { target: action.target }),
      ...(action.reason === undefined ? {} : { reason: action.reason }),
      ...(kind === 'hand' && target !== undefined && target !== holder ? { ladder: 'horizontal', nonDefault: true } : {}),
      ...(kind === 'hand' && target === holder ? { ladder: 'nudge' } : {}),
      ...(kind === 'new-bot' ? { ladder: 'new-bot' } : {}),
      ...(kind === 'stop' ? { ladder: 'stop' } : {}),
      ...(kind === 'self' ? { ladder: 'self' } : {}),
    }
    if (!followUp) pending.firstKind = kind
    recordEta(record)
    if (work !== undefined) {
      pushHistory(work, { at: record.at, event: 'eta-action', kind, ...(record.target === undefined ? {} : { target: record.target }) })
      save()
    }
    return record
  }

  // A raise is only temporary for a work that is behind: the pending reminder names it.
  const etaTargetOf = (sessionId, botId) => (etaPending.get(sessionId) ?? []).find(entry => works()[entry.work]?.to === botId)?.work

  // A Main Bot raised the model or the thinking level of a Bot that is behind its
  // estimate. The values before are kept, so a temporary raise goes back when the work
  // ends, and the audit says which it was.
  function recordEscalation({ sessionId, bot, before, after, kind, temporary = false }) {
    const list = etaPending.get(sessionId)
    if (list === undefined || bot === undefined) return undefined
    const pending = list.find(entry => works()[entry.work]?.to === bot.id)
    if (pending === undefined) return undefined
    const work = works()[pending.work]
    if (work === undefined) return undefined
    const at = Date.now()
    const from = { ...(before?.model === undefined ? {} : { model: before.model }), ...(before?.effort === undefined ? {} : { effort: before.effort }) }
    const to = { ...(after?.model === undefined ? {} : { model: after.model }), ...(after?.effort === undefined ? {} : { effort: after.effort }) }
    work.escalation = { at, kind, bot: bot.id, from, to, temporary: temporary === true, restored: false }
    pushHistory(work, { at, event: 'escalated', kind, ...(to.effort === undefined ? {} : { effort: to.effort }), ...(to.model === undefined ? {} : { model: to.model }) })
    recordEta({ work: pending.work, kind, bot: bot.name, from, to, temporary: temporary === true })
    return { work: pending.work, kind, from, to }
  }

  // A temporary raise goes back when the work it was made for ends, unless the Bot was
  // changed to something else meanwhile: a later decision wins.
  function restoreEscalation(id, work) {
    const escalation = work?.escalation
    if (escalation === undefined || escalation.temporary !== true || escalation.restored === true) return
    escalation.restored = true
    const patch = {
      ...(escalation.to.model === undefined ? {} : { model: escalation.from.model ?? '' }),
      ...(escalation.to.effort === undefined ? {} : { effort: escalation.from.effort ?? '' }),
    }
    void (async () => {
      const bot = rt.botOf(escalation.bot)
      if (bot === undefined) return
      const stillRaised = (escalation.to.model === undefined || bot.model === escalation.to.model)
        && (escalation.to.effort === undefined || bot.effort === escalation.to.effort)
      if (!stillRaised) {
        recordEta({ work: id, kind: 'restore-skipped', bot: bot.name, why: 'the Bot was changed meanwhile' })
        return
      }
      await Promise.resolve(rt.updateBot?.(bot.id, patch)).catch(error => rt.warn('ds-bot: %s was not put back after the work ended: %s', bot.name, error))
      recordEta({ work: id, kind: 'restore', bot: bot.name, model: escalation.from.model, effort: escalation.from.effort })
    })()
  }

  // One line per open work that is being done: what was expected, how long it has run,
  // and whether the team already raised the Bot for it. The panel shows it; the user is
  // not asked to act on it.
  function runningWorks(at = Date.now()) {
    const rows = []
    for (const [id, work] of Object.entries(works())) {
      if (work.to === undefined || work.proposal !== undefined) continue
      if (waitsForUser(workStateOf(work, at).state)) continue
      rows.push({
        id,
        botId: work.to,
        bot: nameOf(work.to),
        ...(work.from === undefined || nameOf(work.from) === undefined ? {} : { askedBy: nameOf(work.from) }),
        at: work.at,
        ...etaView(work, at),
        ...(work.escalation === undefined ? {} : { escalated: true, escalation: work.escalation.kind }),
      })
    }
    return rows
  }

  // A model call that failed for good: the owner cannot answer, so its open work is
  // marked failed and the Bot that asked is told what happened, instead of waiting on a
  // chain that silently stopped.
  async function notifyFailure(work, line) {
    if (work.from === undefined || rt.botOf(work.from) === undefined) return
    const text = `The work you handed on to ${nameOf(work.to)} could not be answered: its model calls kept failing (${line}) after the retries. The work is marked failed. Decide what to do with it: send it again, hand it to another Bot, or tell the user.`
    await rt.deliver({ fromId: work.to, toId: work.from, role: 'work-failed', text })
  }

  function failWorkOf(sessionId, failure, attempts = 0) {
    const botId = rt.selfOf(sessionId)
    if (botId === undefined) return false
    const at = Date.now()
    const line = `${failure?.code ?? 'ERROR'}${failure?.message ? `: ${String(failure.message).slice(0, 200)}` : ''}`
    let changed = false
    for (const [id, work] of Object.entries(works())) {
      if (work.to !== botId) continue
      if (work.report !== undefined && work.report.state !== 'progress') continue
      if (waitsForUser(workStateOf(work, at).state)) continue
      work.report = { state: 'failed', summary: `the model call failed after ${attempts} retries (${line})`, at }
      // The chain is not coming back by itself: the nudge would only burn turns on the
      // same failing route.
      work.halted = { at, reason: 'llm-failed' }
      pushHistory(work, { at, event: 'failed', summary: `model call failed after ${attempts} retries: ${line}` })
      changed = true
      void notifyFailure(work, line).catch((error) => {
        rt.warn('ds-bot: the failure of work %s was not reported: %s', id, error)
        noteFault('delivery')
        save()
      })
    }
    if (changed) save()
    return changed
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
    // Read what the live background jobs wrote since the last sweep: a Bot waiting on
    // one that is still writing is making progress, not stalling.
    rt.sampleJobs?.(at)
    let changed = false
    for (const [id, work] of Object.entries(works())) if (work.wake !== undefined) flushWake(id)
    for (const [id, work] of Object.entries(works())) {
      // A stall the user already dismissed needs no place in the team file: its row is
      // hidden for good, so the sweep clears it. One that handed on work of its own is
      // kept while that work is still out, the same as a dismissal now leaves it.
      if (stalledWork(work) && (work.open ?? []).length === 0) {
        const row = workRowOf(work)
        if (dismissedAt(`${row.kind}:${id}`, row.since)) {
          dropWork(id)
          changed = true
          continue
        }
      }
      if (work.stalled !== undefined) continue
      const report = stalledReport(work, at, leasePolicy.deadline)
      if (report === undefined) continue
      // Waiting for a background job of the Bot that holds the work is progress while
      // the job is expected to run, or past that while it still writes something. A job
      // that has gone silent past twice its expected span stops excusing the silence,
      // and the report the asker reads says so.
      const jobs = rt.liveJobsOf?.(work.to) ?? []
      if (jobs.some(job => jobInProgress(job, at))) continue
      const silentJob = jobs.find(job => !jobInProgress(job, at))
      if (silentJob !== undefined) {
        const since = silentJob.lastActivityAt ?? silentJob.startedAt ?? at
        report.summary = `${report.summary}; a background job has produced no output for ${Math.max(1, Math.round((at - since) / 60_000))} min`
      }
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
    // The estimate is checked on the same tick as the lease: both are about time.
    if (sweepEta(at)) changed = true
    return changed
  }
  rt.ctx?.effect?.(() => {
    const timer = setInterval(() => sweepStalled(), 60_000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'ds-bot: mark work that stopped reporting')

  // --- Keeping a chain alive --------------------------------------------------------
  //
  // A Bot that ends its turn with its work still open and nothing running leaves the
  // chain stopped until someone writes to it. The host nudges it instead: one input
  // that says what is still open, how many attempts were made and what to do, once
  // every `after` seconds and `max` times. After that the work is marked stalled and
  // the Bot that asked is told. The counters live on the work, so a restart does not
  // forget a chain that was waiting.
  const resumePolicy = resumePolicyOf(rt.config)
  const RESUME_AUDIT_MAX = 200
  const resumeLog = () => (state.resumeAudit ??= [])
  function recordResume(entry) {
    resumeLog().push({ at: Date.now(), ...entry })
    if (resumeLog().length > RESUME_AUDIT_MAX) resumeLog().splice(0, resumeLog().length - RESUME_AUDIT_MAX)
    save()
  }

  // What the owner did last, in one sentence, so the nudge is about this work and not a
  // generic "keep going".
  function lastStepOf(work) {
    const history = work.history ?? []
    for (let at = history.length - 1; at >= 0; at--) {
      const event = history[at]
      if (event.event === 'progress' && event.summary !== undefined) return `The last progress it reported: ${event.summary}.`
      if (event.event === 'escalated') return 'The Bot was already raised to a higher thinking level or model for it.'
      if (event.event === 'stalled') return 'It had stopped reporting before.'
    }
    const back = (work.results ?? []).at(-1)
    if (back !== undefined) return `Sub-work it handed on (${back.name}) has come back.`
    return 'It has not reported anything about it yet.'
  }

  async function notifyContinue(id, work, attempt) {
    const text = `Your work ${id} is still open (${workStateOf(work).state}), attempt ${attempt} of ${resumePolicy.max}. ${lastStepOf(work)} Continue from where you stopped instead of waiting for a new message: finish it and call report ready, or call report failed / blocked with what stops it. If it is still open after the last attempt, it is marked stalled and the Bot that asked for it is told.`
    await rt.deliver({ fromId: work.from, toId: work.to, role: 'work-continue', text })
  }

  // One pass over every open work: schedule the first nudge, wait out a running turn or
  // a live job, nudge when the owner is free, and give up after the last attempt.
  function sweepResume(at = Date.now()) {
    rt.sampleJobs?.(at)
    let changed = false
    const defer = (work, until) => {
      if (work.resume?.nextAt === until) return
      work.resume = { ...work.resume, nextAt: until }
      changed = true
    }
    for (const [id, work] of Object.entries(works())) {
      const open = resumeOpen(work, at)
      if (open === undefined || open.gaveUp) continue
      if (open.attempts >= resumePolicy.max) {
        // Out of attempts: the chain is not moving, so it is stalled for the Bot that
        // asked rather than being nudged for ever.
        work.resume = { attempts: open.attempts, nextAt: at, gaveUp: true, at }
        const report = { state: 'blocked', summary: `still open after ${open.attempts} continue attempts`, at, stalled: true, reason: 'no_continue', attempts: open.attempts }
        work.report = report
        work.stalled = { at, action: 'continue' }
        pushHistory(work, { at, event: 'resume-gave-up', attempts: open.attempts })
        recordResume({ work: id, bot: nameOf(work.to), kind: 'gave-up', attempts: open.attempts, max: resumePolicy.max })
        changed = true
        void notifyStall(work, report).catch((error) => {
          rt.warn('ds-bot: the stalled work %s was not reported: %s', id, error)
          delete work.stalled
          noteFault('delivery')
          save()
        })
        continue
      }
      const nextAt = open.nextAt ?? (work.at ?? at) + resumePolicy.after
      if (at < nextAt) {
        if (open.nextAt === undefined) defer(work, nextAt)
        continue
      }
      const chat = rt.chatOf(work.to)
      // A running turn is the owner working, and a live job may wake it when it
      // settles: neither is a stopped chain, so the clock moves on instead of nudging.
      if (chat !== undefined && rt.live.get(chat)?.turn !== undefined) { defer(work, at + resumePolicy.after); continue }
      const jobs = rt.liveJobsOf?.(work.to) ?? []
      if (jobs.some(job => jobInProgress(job, at))) { defer(work, at + resumePolicy.after); continue }
      const attempt = open.attempts + 1
      work.resume = { attempts: attempt, at, nextAt: at + resumePolicy.after }
      pushHistory(work, { at, event: 'resumed', attempt })
      recordResume({ work: id, bot: nameOf(work.to), kind: 'continue', attempt, max: resumePolicy.max })
      changed = true
      void notifyContinue(id, work, attempt).catch((error) => {
        // It was not delivered, so the attempt does not count: the next pass tries again.
        rt.warn('ds-bot: work %s was not nudged along: %s', id, error)
        work.resume = { attempts: attempt - 1, nextAt: at }
        noteFault('delivery')
        save()
      })
    }
    if (changed) save()
    return changed
  }

  // The user or a Main Bot stopped this Bot's turn: the chain is theirs to restart, so
  // the nudge does not bring it back. A report from the owner clears the mark.
  function noteWorkHalt(botId, reason = 'stopped') {
    if (botId === undefined) return false
    const at = Date.now()
    let halted = 0
    for (const work of Object.values(works())) {
      if (work.to !== botId || work.halted !== undefined) continue
      if (waitsForUser(workStateOf(work, at).state)) continue
      work.halted = { at, reason: String(reason).slice(0, 100) }
      pushHistory(work, { at, event: 'halted' })
      halted += 1
    }
    if (halted === 0) return false
    recordResume({ kind: 'halted', bot: nameOf(botId), reason, works: halted })
    save()
    return true
  }

  // A steer cut keeps the turn's work and goes on in the next turn, so it is not a stop.
  rt.ctx?.on?.('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    const reason = event.data?.reason
    if (reason?.kind !== 'aborted') return
    if (reason.reason?.reason === STEER_CUT) return
    noteWorkHalt(rt.selfOf(session?.id), reason.reason?.reason ?? reason.reason?.kind ?? 'stopped')
  })

  rt.ctx?.effect?.(() => {
    const timer = setInterval(() => sweepResume(), 5_000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'ds-bot: nudge a chain that stopped')

  Object.assign(rt, { workOf, openWork, closeWork, dropWork, takenWork: taken, lateWork, answerMissed, ownsWork: owns, waitsWork: waits, holdWork: hold, reportWork: reportOn, jobEnded, flushWake, sweepStalled, sweepResume, resumePolicy, leasePolicy, proactive, proposeWork: propose, workAuthorityOf, proposalRefusal, recordProposal, approveProposal, noteWorkTurn, noteFault, workStats, workHistory, workHealth, activeTurns, needsYou, dismissNeeds, workState, workStateOf, workAsker: askedBy, answerText, replyDelivery, upstreamOf, sameWork, forgetBotWork: forgetBot, statusOf, waitingView, settleSubWork, subWorkRun, nameSubWork, runningWorks, noteEtaAction, recordEscalation, etaTargetOf, etaAdvice: id => escalationAdvice(works()[id]), etaAudit: () => etaAuditLog(), resumeAudit: () => resumeLog(), noteWorkHalt, failWorkOf })
}
