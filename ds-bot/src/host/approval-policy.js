// The approval policy: what the team decides itself before a card ever reaches the user.
//
// A Bot's own chat used to forward every approval to the user, who might be in another
// chat and never learn that a Bot stopped. The first level is a fixed table: a request
// that stays inside the workspace or a copy profile, installs dependencies, updates a
// lock file, runs tests or only reads is allowed; one that writes the user's DSH data,
// deletes outside the workspace or publishes outside the team is refused; everything
// else, and anything touching credentials, money or something irreversible, waits for
// the user. The table is matched by tool name and the words of the reason — never by a
// model call, so deciding takes no turn and cannot stall again.
import { homedir, tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'

const textOf = value => String(value ?? '').replace(/\r\n?/g, '\n')

const DELETE = /\b(rm|rmdir|del|unlink|remove-item)\b/i
const CLEANUP = /(?:^|[\\/])(node_modules|dist|build|out|coverage|\.cache|\.next|target)(?:[\\/]|$)/i
const PUBLISH = new RegExp([
  String.raw`\b(npm|pnpm|yarn|bun)\s+publish\b`,
  String.raw`\bgh\s+release\b`,
  String.raw`\bdocker\s+push\b`,
  String.raw`\btwine\s+upload\b`,
  String.raw`\bsubmit\s+(?:the\s+)?(?:paper|manuscript|article|abstract)\b`,
  String.raw`\b(upload|send|post)\b[^\n]{0,80}\b(dropbox|gist|pastebin|webhook|telegram|slack|discord|twitter|x\.com)\b`,
  String.raw`\bcurl\b[^\n]{0,200}\b(-d|--data|--form|-F)\b[^\n]{0,200}https?://`,
  String.raw`投稿|发布到|对外发布|上传到外部`,
].join('|'), 'i')
const CREDENTIAL = /\b(api[ _-]?key|access[ _-]?token|auth[ _-]?token|secret|password|passwd|credential|private[ _-]?key)\b|凭据|密钥|密码|口令|私钥/i
const MONEY = /\b(purchase|payment|billing|invoice|subscription|checkout|credit card)\b|\bpay\b(?!load)|花钱|支付|付款|订阅|购买/i
const IRREVERSIBLE = /\b(drop\s+(?:table|database)|truncate\s+(?:table|database)|mkfs|fdisk|diskutil\s+erase|dd\s+if=|shutdown|reboot|format\s+[a-z]:)/i
const GLOBAL_INSTALL = /\b(npm|pnpm|yarn|bun)\s+(install|add)\b[^\n]{0,40}(-g|--global)\b|\bpip3?\s+install\b[^\n]{0,40}(--user|--system)\b/i
const COPY_PROFILE = /(副本|copy|temp|temporary|临时|测试|sandbox|scratch)[\s_-]*(of\s+the\s+)?profile|profile[\s_-]*(副本|copy|temp|temporary|临时|sandbox|scratch)/i
const INSTALL = /\b(npm|pnpm|yarn|bun)\s+(install|ci|add)\b|\bpip3?\s+install\b|\buv\s+(pip\s+)?install\b|\bpoetry\s+install\b|装依赖|安装依赖|依赖安装/i
const LOCKFILE = /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|Cargo\.lock|更新\s*lock|lock\s*file)/i
const TESTS = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bpytest\b|\bvitest\b|\bjest\b|\bmocha\b|\bcargo\s+test\b|\bgo\s+test\b|\bnode\s+--test\b|跑测试|运行测试|单元测试/i
const LOCAL_TASK = /\b(npm|pnpm|yarn|bun)\s+run\s+(lint|format|build|typecheck|check|dev)\b|\bnode\s+scripts\/build-client\.mjs\b|\btsc\b|\beslint\b|\bprettier\b|\bmake\b|\bcargo\s+(build|check|clippy|fmt)\b|\bgo\s+(build|vet)\b|构建|编译|格式化|检查/i
const READ_ONLY = /\b(cat|head|tail|sed\s+-n|grep|rg|find|ls|stat|file|wc|du|df|git\s+(status|log|diff|show))\b|查看|读取|只读|查询/i
const WRITES = /\b(tee|mv|cp|touch|mkdir|rm|rmdir|chmod|chown|npm\s+(install|ci|publish))\b|[>]{1,2}\s*\S|sed\s+-i/i

// The absolute paths a request names, with `~` expanded. URLs are not paths; a path cut
// at a space still decides which root it lies in.
export function pathsIn(value) {
  const found = new Set()
  for (const match of textOf(value).matchAll(/(?:^|[\s"'`(=:;,>])(~\/[^\s"'`;|&)\]>]+|\/[A-Za-z0-9._@%+~/-]+|[A-Za-z]:[\\/][^\s"'`;|&)\]>]+)/g)) {
    const raw = match[1].replace(/[.,;:]+$/, '')
    if (raw.startsWith('//') || raw.includes('://')) continue
    found.add(raw.startsWith('~') ? resolve(homedir(), raw.slice(1).replace(/^\//, '')) : resolve(raw))
  }
  return [...found]
}

const inside = (path, root) => {
  const base = resolve(root)
  return path === base || path.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

const withinAny = (path, roots) => roots.some(root => inside(path, root))

// The policy table, in the order it is read: refusal, then the questions only the user
// may answer, then the routine work the team may do itself.
export const APPROVAL_RULES = [
  {
    id: 'user-dsh-data',
    decision: 'reject',
    why: 'writes the user\'s own DSH data',
    test: ctx => ctx.allPaths.some(path => withinAny(path, ctx.dshRoots) && !withinAny(path, ctx.allowed)),
  },
  {
    id: 'delete-outside-workspace',
    decision: 'reject',
    why: 'deletes something outside the workspace',
    test: ctx => DELETE.test(ctx.haystack) && ctx.allPaths.some(path => !withinAny(path, ctx.allowed)),
  },
  {
    id: 'external-publish',
    decision: 'reject',
    why: 'publishes or sends content outside the team',
    test: ctx => PUBLISH.test(ctx.haystack),
  },
  {
    id: 'credentials',
    decision: 'escalate',
    why: 'involves a credential',
    test: ctx => CREDENTIAL.test(ctx.haystack),
  },
  {
    id: 'money',
    decision: 'escalate',
    why: 'spends money',
    test: ctx => MONEY.test(ctx.haystack),
  },
  {
    id: 'irreversible-action',
    decision: 'escalate',
    why: 'cannot be undone',
    test: ctx => IRREVERSIBLE.test(ctx.haystack),
  },
  {
    id: 'irreversible-delete',
    decision: 'escalate',
    why: 'deletes something that is not a build artifact',
    test: (ctx) => {
      if (!DELETE.test(ctx.haystack) || ctx.allPaths.length === 0) return false
      if (ctx.allPaths.some(path => !withinAny(path, ctx.allowed))) return false
      return ctx.allPaths.some(path => !CLEANUP.test(path))
    },
  },
  {
    id: 'global-install',
    decision: 'escalate',
    why: 'installs a package system-wide',
    test: ctx => GLOBAL_INSTALL.test(ctx.haystack),
  },
  {
    id: 'copy-profile',
    decision: 'allow',
    why: 'works in a copy of the profile',
    test: (ctx) => {
      if (COPY_PROFILE.test(ctx.haystack)) return true
      const temp = resolve(tmpdir())
      return ctx.allPaths.some(path => /(?:^|[\\/])profile(?:[\\/]|$)/i.test(path) && (inside(path, temp) || withinAny(path, ctx.allowed)))
    },
  },
  {
    id: 'outside-workspace',
    decision: 'escalate',
    why: 'changes a path outside the workspace',
    test: ctx => ctx.allPaths.some(path => !withinAny(path, ctx.allowed)),
  },
  {
    id: 'node-modules',
    decision: 'allow',
    why: 'works on node_modules',
    test: ctx => /\bnode_modules\b/i.test(ctx.haystack),
  },
  {
    id: 'workspace-path',
    decision: 'allow',
    why: 'stays inside the workspace',
    test: ctx => ctx.allPaths.length > 0 && ctx.allPaths.every(path => withinAny(path, ctx.allowed)),
  },
  {
    id: 'install-deps',
    decision: 'allow',
    why: 'installs dependencies',
    test: ctx => INSTALL.test(ctx.haystack),
  },
  {
    id: 'lockfile',
    decision: 'allow',
    why: 'updates a lock file',
    test: ctx => LOCKFILE.test(ctx.haystack),
  },
  {
    id: 'run-tests',
    decision: 'allow',
    why: 'runs tests',
    test: ctx => TESTS.test(ctx.haystack),
  },
  {
    id: 'local-task',
    decision: 'allow',
    why: 'runs a local build or check',
    test: ctx => LOCAL_TASK.test(ctx.haystack),
  },
  {
    id: 'read-only',
    decision: 'allow',
    why: 'only reads',
    test: (ctx) => {
      if (/^(read|grep|glob|list|ls|web_search|web_fetch)$/.test(ctx.tool)) return !WRITES.test(ctx.haystack)
      return READ_ONLY.test(ctx.haystack) && !WRITES.test(ctx.haystack)
    },
  },
]

/**
 * What the team decides about one approval, before any user card: `allow` and `reject`
 * are final and name the rule; `escalate` waits for the user with the reason it could
 * not decide. `paths` names the roots it compares against.
 */
export function decideApproval({ tool, reason, code, text, paths = {}, ...rest } = {}) {
  const haystack = [reason, code, text].filter(value => String(value ?? '').trim() !== '').map(textOf).join('\n')
  const context = {
    ...rest,
    tool: textOf(tool).trim().toLowerCase(),
    reason: textOf(reason),
    code: textOf(code),
    text: textOf(text),
    haystack,
    dshRoots: [...new Set([paths.dshHome, paths.userDshHome].filter(Boolean).map(path => resolve(path)))],
    allowed: [...new Set([paths.home, paths.workspace, paths.workdir].filter(Boolean).map(path => resolve(path)))],
    allPaths: pathsIn(haystack),
  }
  for (const rule of APPROVAL_RULES) {
    if (rule.test(context)) return { decision: rule.decision, rule: rule.id, why: rule.why }
  }
  return { decision: 'escalate', rule: 'unmatched', why: 'no rule covers this request' }
}
