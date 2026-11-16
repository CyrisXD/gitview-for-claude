import type { Commit, Details, FileChange, FileDiff, GraphData, Operation, RemotesMode } from '../types'
import { visibleText } from './actions'
import { DATE, FORMAT, WORKING, merge, parseLog } from './graph'

export type Run = (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const MAX_DIFF = 90_000
// A commit message longer than this would push the drawing past what the desktop app draws.
const MAX_MESSAGE = 8_000
// The pane reads on its own, every few seconds: a repository's own config must not run anything
// then (core.fsmonitor on status, an external diff or textconv driver on diff).
const git = (...args: string[]) => ['git', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', ...args]
const SAFE_DIFF = ['--no-ext-diff', '--no-textconv']

// raw decides a redraw; refs is the same without the working tree's status.
// statusError: git status failed, so what the working tree holds is not known.
export type Graph = GraphData & { raw: string; refs: string; statusError?: string }

const OPERATIONS: [Operation, string][] = [
  ['merge', 'MERGE_HEAD'],
  ['cherry-pick', 'CHERRY_PICK_HEAD'],
  ['revert', 'REVERT_HEAD'],
  ['rebase', 'REBASE_HEAD'],
]

// More remote branches than this and auto leaves their history out: each one open opens a lane.
export const AUTO_HIDE = 50

// `only` (a full ref name, refs/heads/x or refs/remotes/o/x) narrows the history to what that branch reaches.
export async function loadGraph(run: Run, limit: number, only: string | null = null, remotesMode: RemotesMode = 'auto'): Promise<Graph> {
  // Newest first: the branch menu can show only the first few dozen.
  const locals = await run(git('for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes'))
  // Every branch by full name, local then remote, without the remotes' HEAD pointers.
  const branches = locals.exitCode === 0 ? locals.stdout.split('\n').filter(r => r && !r.endsWith('/HEAD')) : []
  const remoteCount = branches.filter(r => r.startsWith('refs/remotes/')).length
  const remotesHidden = !only && (remotesMode === 'hide' || (remotesMode === 'auto' && remoteCount > AUTO_HIDE))
  let revs = only ? [only, '--'] : ['--exclude=refs/stash', '--all']
  if (remotesHidden) {
    // A local branch's upstream stays, so ahead and behind still draw.
    const up = await run(git('for-each-ref', '--format=%(upstream)', 'refs/heads'))
    const tracked = up.stdout.split('\n').filter(r => branches.includes(r))
    revs = ['--exclude=refs/stash', '--exclude=refs/remotes/*', '--all', ...tracked, '--']
  }
  const log = await run(git('log', '--topo-order', `-n${limit + 1}`, DATE, FORMAT, ...revs))
  if (log.exitCode !== 0) {
    const fail = (status: GraphData['status'], message: string): Graph => ({
      status,
      message: visibleText(message),
      commits: [],
      hasMore: false,
      remotes: [],
      branch: null,
      headHash: '',
      localBranches: [],
      raw: log.stderr,
      refs: log.stderr,
    })
    if (/not a git repository/i.test(log.stderr)) return fail('not-repo', 'This session’s folder is not a git repository.')
    if (/does not have any commits/i.test(log.stderr)) return fail('empty', '')
    return fail('error', log.stderr.trim() || `git exited with ${log.exitCode}`)
  }
  const [stash, status, head, remotes, branch] = await Promise.all([
    run(git('stash', 'list', DATE, FORMAT.replace('%D', '%gd'))),
    run(git('status', '--porcelain')),
    run(git('rev-parse', 'HEAD')),
    run(git('remote')),
    run(git('symbolic-ref', '--short', '-q', 'HEAD')),
  ])
  // The pseudo-ref each stopped operation leaves; REBASE_HEAD is set while a rebase waits on a conflict.
  const ops = await Promise.all(OPERATIONS.map(([, ref]) => run(git('rev-parse', '-q', '--verify', ref))))
  const operation = OPERATIONS.find((_, i) => ops[i]!.exitCode === 0 && ops[i]!.stdout.trim() !== '')?.[0] ?? null
  const all = parseLog(log.stdout)
  const statusError = status.exitCode === 0 ? undefined : status.stderr.trim() || `git status exited with ${status.exitCode}`
  const changed = statusError ? 0 : status.stdout.split('\n').filter(Boolean).length
  const headHash = head.stdout.trim()
  const refs = [log.stdout, stash.stdout, headHash, remotes.stdout, branch.stdout, locals.stdout, operation].join('\x00')
  // Narrowed to a branch, the uncommitted row shows only when HEAD is in its history.
  const working: Commit | null =
    (changed || statusError) && headHash && (!only || all.some(c => c.hash === headHash))
      ? {
          kind: 'working',
          hash: WORKING,
          parents: [headHash],
          refs: [],
          author: '*',
          date: '*',
          subject: statusError ? 'Uncommitted Changes (unknown: git status failed)' : `Uncommitted Changes (${changed})`,
        }
      : null
  return {
    status: all.length ? 'ok' : 'empty',
    message: '',
    commits: merge(
      all.slice(0, limit),
      // %gd follows --date, so the stash@{n} names come from the list order.
      stash.exitCode === 0 ? parseLog(stash.stdout, 'stash').map((c, i) => ({ ...c, refs: [`stash@{${i}}`] })) : [],
      working,
    ),
    hasMore: all.length > limit,
    // A remote named like an option (set in .git/config) would be read as one by push: left out.
    remotes: remotes.stdout.split('\n').filter(r => r && !r.startsWith('-')),
    branch: branch.stdout.trim() || null,
    headHash,
    localBranches: branches.filter(r => r.startsWith('refs/heads/')).map(r => r.slice('refs/heads/'.length)),
    branches,
    operation,
    remoteCount,
    remotesHidden,
    // What decides a redraw: everything but the relative parts that do not move.
    raw: `${refs}\x00${status.stdout}`,
    refs,
    statusError,
  }
}

// Whether the history needs reading again: every ref and where it points, the remotes, the stash
// list, the working tree, HEAD and any stopped operation. Far cheaper than log --topo-order --all.
export async function fingerprint(run: Run): Promise<string> {
  const outs = await Promise.all([
    run(git('for-each-ref', '--format=%(objectname) %(refname)')),
    run(git('remote')),
    run(git('stash', 'list', '--format=%H')),
    run(git('status', '--porcelain')),
    // The same commands loadGraph runs, so a load right after can reuse these answers.
    run(git('symbolic-ref', '--short', '-q', 'HEAD')),
    run(git('rev-parse', 'HEAD')),
    ...OPERATIONS.map(([, ref]) => run(git('rev-parse', '-q', '--verify', ref))),
  ])
  return outs.map(r => `${r.exitCode}:${r.stdout}`).join('\0')
}

// `git diff --name-status -z` and `--numstat -z`, joined by path.
export function parseChanges(nameStatus: string, numstat: string): FileChange[] {
  const files: FileChange[] = []
  const ns = nameStatus.split('\0')
  for (let i = 0; i < ns.length - 1; ) {
    const code = ns[i++]!
    if (!code) continue
    const status = code[0]!
    if (status === 'R' || status === 'C') {
      const oldPath = ns[i++]!
      files.push({ status, oldPath, path: ns[i++]!, added: null, removed: null })
    } else {
      files.push({ status, path: ns[i++]!, added: null, removed: null })
    }
  }
  const nums = numstat.split('\0')
  for (let i = 0; i < nums.length - 1; ) {
    const [a = '-', r = '-', path = ''] = nums[i++]!.split('\t')
    const target = path === '' ? (i++, nums[i++]!) : path // a rename: old, new follow
    const file = files.find(f => f.path === target)
    if (file) {
      file.added = a === '-' ? null : Number(a)
      file.removed = r === '-' ? null : Number(r)
    }
  }
  return files
}

const baseOf = (c: Commit) => (c.kind === 'working' ? 'HEAD' : c.parents[0] ?? EMPTY_TREE)
const rangeOf = (c: Commit) => (c.kind === 'working' ? [baseOf(c)] : [baseOf(c), c.hash])

export async function loadDetails(run: Run, c: Commit): Promise<Details> {
  const range = rangeOf(c)
  const none = Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
  const [names, nums, info, untracked, unmerged] = await Promise.all([
    run(git('diff', ...SAFE_DIFF, '--name-status', '-z', '-M', ...range)),
    run(git('diff', ...SAFE_DIFF, '--numstat', '-z', '-M', ...range)),
    c.kind === 'working'
      ? none
      : run(git('show', '-s', '--format=%an%x1f%ae%x1f%aD%x1f%P%x1f%B', c.hash)),
    c.kind === 'working'
      ? run(git('ls-files', '--others', '--exclude-standard', '-z'))
      : none,
    // Diffed against HEAD a conflicted file reads as M; the index knows it is unmerged.
    c.kind === 'working' ? run(git('diff', ...SAFE_DIFF, '--name-only', '-z', '--diff-filter=U')) : none,
  ])
  const failed = [names, nums, info, untracked, unmerged].find(r => r.exitCode !== 0)
  if (failed) return { ...emptyDetails(c.hash), status: 'error', message: visibleText(failed.stderr.trim()) }

  const [author = '', email = '', date = '', parents = '', ...body] = info.stdout.split('\x1f')
  const files = parseChanges(names.stdout, nums.stdout)
  const conflicted = new Set(unmerged.stdout.split('\0').filter(Boolean))
  for (const f of files) if (conflicted.has(f.path)) f.status = 'U'
  for (const path of untracked.stdout.split('\0').filter(Boolean))
    files.push({ status: '?', path, added: null, removed: null })
  return {
    hash: c.hash,
    status: 'ok',
    message: clipMessage(visibleText(c.kind === 'working' ? c.subject : body.join('\x1f').trim())),
    author,
    email,
    date,
    parents: parents.split(' ').filter(Boolean),
    files,
  }
}

const clipMessage = (s: string) => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}\n… (message cut short)` : s)

// The person's own ssh command, if git is set to one.
export const sshCommand = (run: Run) => run(git('config', '--get', 'core.sshCommand')).then(r => r.stdout.trim(), () => '')

export const emptyDetails = (hash: string): Details => ({
  hash,
  status: 'loading',
  message: '',
  author: '',
  email: '',
  date: '',
  parents: [],
  files: [],
})

export async function loadDiff(run: Run, c: Commit, file: FileChange): Promise<FileDiff> {
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path]
  const r =
    file.status === '?'
      ? await run(git('diff', ...SAFE_DIFF, '--no-index', '--', '/dev/null', file.path))
      : await run(git('diff', ...SAFE_DIFF, '-M', ...rangeOf(c), '--', ...paths))
  // --no-index exits 1 when the files differ, which they always do here.
  const ok = r.exitCode === 0 || (file.status === '?' && r.exitCode === 1)
  // Shown only, never run: a diff or error may hold escapes that would rewrite the terminal.
  const text = visibleText(ok ? hunks(r.stdout) : r.stderr.trim())
  // Cut at a hunk boundary: Code's diff format draws a hunk cut midway as plain text.
  const cut = text.length > MAX_DIFF ? text.lastIndexOf('\n@@', MAX_DIFF) + 1 || MAX_DIFF : text.length
  return {
    hash: c.hash,
    path: file.path,
    status: ok ? 'ok' : 'error',
    text: text.slice(0, cut),
    isTruncated: text.length > MAX_DIFF,
  }
}

// Code's diff format reads only `@@` hunks; git's header lines (diff --git, index,
// rename, similarity) make it fall back to plain text. A pure rename has no hunks.
export const hunks = (diff: string) => {
  const at = diff.search(/^@@/m)
  return at < 0 ? '' : diff.slice(at)
}
