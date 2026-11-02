import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toolTarget } from '../src/client/text.js'

// The running row names what the tool works on, so a call taking minutes shows what it
// does: the shell command's first line, the file, the page or the query.
const args = values => key => values[key]

test('a shell tool is named by its command', () => {
  assert.equal(toolTarget('bash', args({ command: 'npm test -- --watch' })), 'npm test -- --watch')
  assert.equal(toolTarget('pwsh', args({ command: 'Get-ChildItem' })), 'Get-ChildItem')
})

test('a multi-line command keeps its first line only', () => {
  assert.equal(toolTarget('bash', args({ command: 'cd app\nnpm run build\n' })), 'cd app')
})

test('a long command is cut to one readable line', () => {
  const target = toolTarget('bash', args({ command: `grep -rn "${'x'.repeat(120)}" .` }))
  assert.equal(target.length, 60)
  assert.ok(target.endsWith('…'))
})

test('a file tool is named by the file, not its folder', () => {
  assert.equal(toolTarget('read', args({ file_path: '/Users/gunk/.dsh/bot/workspace/DS-Bot/ds-bot/index.js' })), 'index.js')
  assert.equal(toolTarget('edit', args({ path: 'src/host/roster.js' })), 'roster.js')
})

test('a page tool is named by its address, a search tool by its query', () => {
  assert.equal(toolTarget('web_fetch', args({ url: 'https://example.com/docs' })), 'https://example.com/docs')
  assert.equal(toolTarget('web_search', args({ query: 'dsh bash timeout' })), 'dsh bash timeout')
  assert.equal(toolTarget('grep', args({ pattern: 'timeoutMs' })), 'timeoutMs')
})

test('an unknown tool or a missing argument names nothing', () => {
  assert.equal(toolTarget('create_bot', args({ name: 'Runtime' })), '')
  assert.equal(toolTarget('bash', args({})), '')
  assert.equal(toolTarget('bash', undefined), '')
})
