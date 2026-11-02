import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/prompt.js'
import { fakeContext } from './fake-ctx.js'

function start() {
  const ctx = fakeContext()
  const bots = new Map([
    ['main', { name: 'Chief' }],
    ['worker', { name: 'Dev', instructions: 'Check files.' }],
  ])
  install({
    ctx,
    selfOf: id => id === 'group-worker' ? 'worker' : id,
    botOf: id => bots.get(id),
    roomOf: id => id === 'room' ? {} : undefined,
    isMain: id => id === 'main',
  })
  const prompt = id => ctx.sections.get('bot-identity').text({ agent: { id } })
  return { ctx, prompt }
}

test('Bots get a scoped progress rule without changing the private/group prompt prefix', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const rules = [
    '- Only for a direct user request in your own chat that needs several steps: write one short sentence of normal reply text before your first tool call, and make that tool call in the same response. Never start such a task with tools alone or end it with a promise. On long tasks, give brief factual updates only at meaningful milestones, then keep working.',
    '- For "[Message from …]" or "[Reply from …]" messages, do not write plans or progress updates: use tools silently, then reply with the answer. Simple answers do not need progress messages.',
    '- In a group chat, the group sees what you write while you work, not only your final reply. For work that takes more than a quick look, start with one short sentence on what you will do, in the same response as your first tool call. After that, write only when you find something the group should know or finish a part of the work, in a sentence or two, not at every step. End with the result. Simple answers need no updates.',
  ]
  for (const id of ['main', 'worker']) {
    for (const rule of rules) {
      assert.ok(prompt(id).split('\n').includes(rule))
      assert.equal(prompt(id).split(rule).length - 1, 1)
    }
  }
  assert.equal(prompt('group-worker'), prompt('worker'))
})

test('the group relay and non-Bot sessions do not get progress instructions', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  assert.match(prompt('room'), /end your turn with an empty reply/)
  assert.doesNotMatch(prompt('room'), /progress|milestone/)
  assert.equal(prompt('outside'), '')
})

// The team discipline is part of the prompt every Bot reads, not a document: these are
// the exact lines, so a change to one of them has to change this test on purpose.
const DISCIPLINE = [
  '- Never report work that did not happen: do not say an experiment ran when it did not, do not write back a number you cannot reproduce, and say plainly when a result is unverified or was measured on a different basis.',
  '- Run long commands in the background — run_in_background, or a job that keeps a log — and collect them with job_output; a long command in the foreground holds a turn that could be answering the user.',
  '- When more than one Bot works in the same repository, each works in a checkout of its own (git worktree); never switch branches in a checkout another Bot or the user is using.',
  '- Report the result, not the transport: never paste message envelopes, delivery markers, or lines such as "[Reply from …]" into what the user reads.',
  '- Write in the user\'s language, lead with the conclusion, then give evidence the user can check, and never promise work you have not done.',
  '- Decide ordinary technical choices yourself and say what you decided; leave only spending money, publishing or submitting work, irreversible actions, account credentials, and promises to outsiders for the user to decide.',
]

test('every Bot reads the team discipline, once, after the team rules', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  for (const id of ['main', 'worker']) {
    const text = prompt(id)
    assert.ok(text.split('\n').includes('## Team discipline'), `${id} has the section`)
    assert.ok(text.indexOf('## Team discipline') > text.indexOf('## How your Bot team works'),
      `${id} reads it after the team rules`)
    for (const rule of DISCIPLINE) {
      assert.ok(text.split('\n').includes(rule), `${id} reads: ${rule.slice(2, 40)}…`)
      assert.equal(text.split(rule).length - 1, 1, `${id} reads it once`)
    }
    // A group renders exactly its Bot's text, so it reads the same discipline.
    assert.equal(prompt(id), prompt(id), `${id}'s prefix stays byte-stable`)
  }
  assert.equal(prompt('group-worker'), prompt('worker'))
  assert.doesNotMatch(prompt('room'), /Team discipline|run_in_background/)
})

test('the Main Bot also reads how a new task is handed on', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const handed = '- A new task is handed on at once: give it to the Bot that fits, or create one if none does, instead of working on it yourself for long, so you stay free for the next request.'
  const sent = '- Say a task went out only after message_bot or post_to_group returned; before that it is not sent.'
  for (const rule of [handed, sent]) {
    assert.ok(prompt('main').split('\n').includes(rule))
    assert.equal(prompt('main').split(rule).length - 1, 1)
    assert.equal(prompt('worker').includes(rule), false, 'a Bot that is not the Main Bot does not read it')
  }
})
