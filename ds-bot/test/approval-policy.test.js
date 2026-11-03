// The approval policy: routine work is allowed, out-of-bounds work is refused, and
// what the table cannot place waits for the user with the reason it could not decide.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decideApproval } from '../src/host/approval-policy.js'

const paths = {
  dshHome: '/Users/me/.dsh',
  home: '/Users/me/.dsh/bot',
  workspace: '/Users/me/work/team/DS-Bot',
  workdir: '/Users/me/work/team/DS-Bot/ds-bot',
}

const decide = input => decideApproval({ paths, ...input })

test('a copy profile and a workspace path are allowed without the user', () => {
  assert.deepEqual(decide({
    tool: 'bash',
    reason: 'escalate sandbox to danger-full-access: 在副本 profile 里装依赖/更新 lock',
    code: 'npm install',
  }), { decision: 'allow', rule: 'copy-profile', why: 'works in a copy of the profile' })
  assert.deepEqual(decide({
    tool: 'bash',
    reason: 'escalate sandbox to danger-full-access: update the lock file',
    code: 'cd /Users/me/work/team/DS-Bot && npm ci',
  }), { decision: 'allow', rule: 'workspace-path', why: 'stays inside the workspace' })
  assert.equal(decide({
    tool: 'bash',
    reason: 'escalate sandbox to danger-full-access: install dependencies',
    code: 'pnpm install',
  }).rule, 'install-deps')
  assert.equal(decide({
    tool: 'bash',
    reason: 'escalate sandbox to danger-full-access: reset the dependencies',
    code: 'rm -rf node_modules',
  }).rule, 'node-modules')
  assert.equal(decide({
    tool: 'bash',
    reason: 'escalate sandbox to danger-full-access: run the unit tests',
    code: 'npm test',
  }).rule, 'run-tests')
  assert.equal(decide({
    tool: 'bash',
    reason: 'escalate sandbox to danger-full-access: read the log',
    code: 'grep -n "error" run.log',
  }).rule, 'read-only')
})

test('writing the user\'s own DSH data is refused', () => {
  assert.deepEqual(decide({
    tool: 'write',
    reason: 'save the copied profile',
    code: '/Users/me/.dsh/profiles/desktop/profile.json',
  }), { decision: 'reject', rule: 'user-dsh-data', why: 'writes the user\'s own DSH data' })
  // The team's own data under ~/.dsh/bot and the workspace inside it is not the user's.
  assert.equal(decide({
    tool: 'bash',
    reason: 'update the state',
    code: 'cat /Users/me/.dsh/bot/workspace/DS-Bot/README.md',
  }).decision, 'allow')
})

test('deleting outside the workspace and publishing outside the team are refused', () => {
  assert.deepEqual(decide({
    tool: 'bash',
    reason: 'escalate sandbox to danger-full-access: clean up',
    code: 'rm -rf /etc/nginx',
  }), { decision: 'reject', rule: 'delete-outside-workspace', why: 'deletes something outside the workspace' })
  assert.deepEqual(decide({
    tool: 'bash',
    reason: 'escalate sandbox to danger-full-access: publish the package',
    code: 'npm publish',
  }), { decision: 'reject', rule: 'external-publish', why: 'publishes or sends content outside the team' })
  assert.equal(decide({
    tool: 'bash',
    reason: 'submit the manuscript',
    code: 'curl -F file=@paper.pdf https://example.com/submit',
  }).rule, 'external-publish')
})

test('credentials, money and irreversible actions wait for the user', () => {
  assert.equal(decide({
    tool: 'bash',
    reason: 'escalate sandbox to danger-full-access: set the API key',
    code: 'export API_KEY=...',
  }).rule, 'credentials')
  assert.equal(decide({
    tool: 'bash',
    reason: 'escalate sandbox to danger-full-access: buy the plan',
    code: 'stripe checkout',
  }).rule, 'money')
  assert.equal(decide({
    tool: 'bash',
    reason: 'escalate sandbox to danger-full-access: drop the table',
    code: 'psql -c "drop table users"',
  }).rule, 'irreversible-action')
  assert.equal(decide({
    tool: 'bash',
    reason: 'escalate sandbox to danger-full-access: delete the report',
    code: 'rm /Users/me/work/team/DS-Bot/report.md',
  }).rule, 'irreversible-delete')
})

test('a rule that does not match escalates with the reason it could not decide', () => {
  const decision = decide({
    tool: 'bash',
    reason: 'escalate sandbox to danger-full-access: do the thing',
    code: 'some-unknown-command --flag',
  })
  assert.equal(decision.decision, 'escalate')
  assert.equal(decision.rule, 'unmatched')
  assert.match(decision.why, /no rule covers/)
})

test('a path outside the workspace escalates even when the command looks routine', () => {
  assert.deepEqual(decide({
    tool: 'bash',
    reason: 'escalate sandbox to danger-full-access: install dependencies elsewhere',
    code: 'cd /opt/other-app && npm install',
  }), { decision: 'escalate', rule: 'outside-workspace', why: 'changes a path outside the workspace' })
})

test('a git push is not refused outright: it waits for the user', () => {
  assert.deepEqual(decide({
    tool: 'bash',
    reason: 'escalate sandbox to danger-full-access: push the branch',
    code: 'git push origin feat/approval-inbox',
  }), { decision: 'escalate', rule: 'unmatched', why: 'no rule covers this request' })
})
