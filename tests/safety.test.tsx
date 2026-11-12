import { pick } from './replay'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { describe, groupsFor } from '../hooks/actions'
import { WORKING } from '../hooks/graph'
import { badges } from '../hooks/graph'
import { parseLog } from '../hooks/graph'

// A typed /gitview; the rest of a real command.run input is left out.
const OPEN = { command: 'gitview', origin: { kind: 'composer' } } as Parameters<Engine['command']['run']>[0]
const PANE = {
  plugin: 'gitview', component: 'Pane', requestId: 'gitview',
  props: { title: 'Gitview', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const
const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const row = (hash: string, parents: string, refs: string, subject: string) =>
  [hash, parents, refs, 'Ada', '10 Nov 2026 14:32', subject].join('\x1f') + '\x1e\n'
const LOG =
  row('fffffff1', 'ccccccc1', 'HEAD -> main, origin/main', 'Second') +
  row('ccccccc1', '', '', 'First')

// A repository whose HEAD can be moved under the pane; every command is kept.
function repo(on: On) {
  const s = {
    head: 'fffffff1', status: '', files: '', reads: [] as string[][], ran: [] as string[],
    op: false, // a merge stopped on a conflict
    statusFails: false,
    inits: [] as { timeoutMs?: number; stdin?: string }[], // what each action command was started with
    act: (_argv: readonly string[]): Promise<ReturnType<typeof ok>> | ReturnType<typeof ok> => ok(''),
  }
  on('command.register', () => ({ value: { command: 'gitview' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const a = e.argv.join(' ')
    if (e.argv[2] !== 'core.quotepath=false') {
      s.ran.push(a)
      s.inits.push({ timeoutMs: e.init?.timeoutMs, stdin: e.init?.stdin })
      return s.act(e.argv)
    }
    if (a.includes('--verify MERGE_HEAD') && s.op) return ok('aaaaaaa1\n')
    if (a.includes('status --porcelain') && s.statusFails)
      return { value: { exitCode: 128, stdout: '', stderr: 'fatal: index file corrupt', isStdoutTruncated: false, isStderrTruncated: false } }
    s.reads.push([...e.argv])
    if (a.includes(' log ')) return ok(LOG)
    if (a.includes('rev-parse HEAD')) return ok(`${s.head}\n`)
    if (a.endsWith(' remote')) return ok('origin\n')
    if (a.includes('symbolic-ref')) return ok('main\n')
    if (a.includes(' show -s ')) return ok('Ada\x1fa@b.c\x1fdate\x1f\x1fFirst')
    if (a.includes('status --porcelain')) return ok(s.status)
    if (a.includes('--name-status')) return ok(s.files)
    return ok('')
  })
  return s
}

test('reads turn off fsmonitor, and diffs turn off external diff and textconv', async ($, on) => {
  const s = repo(on)
  await $.command.run(OPEN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'c:ccccccc1' })
  expect(s.reads.length).toBeGreaterThan(0)
  for (const argv of s.reads) {
    expect(argv.slice(0, 5)).toEqual(['git', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false'])
    if (argv[5] === 'diff') expect(argv.slice(6, 8)).toEqual(['--no-ext-diff', '--no-textconv'])
  }
  expect(s.reads.some(a => a[5] === 'diff')).toBe(true)
  await ui.unmount()
})

test('a typed name starting with - never reaches git', async ($, on) => {
  const s = repo(on)
  await $.command.run(OPEN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'c:ccccccc1' })
  await pick(ui, 'ccccccc1', 'commit:tag')
  await ui.input({ key: 'input:commit:tag', text: '-d' })
  expect(await ui.find({ type: 'Text', text: /can't start with -/ })).toBeDefined()
  expect(s.ran).toEqual([])
  await ui.unmount()
})

test('if HEAD moved since the menu was drawn, Run stops and redraws instead', async ($, on) => {
  const s = repo(on)
  await $.command.run(OPEN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'c:ccccccc1' })
  await pick(ui, 'ccccccc1', 'commit:reset')
  s.head = '88888881' // Claude, or a terminal, moved the branch
  await ui.press({ key: 'run:commit:reset' })
  expect(await ui.find({ type: 'Text', text: /repository changed since this was shown/ })).toBeDefined()
  expect(s.ran).toEqual([])
  // Pressed again against what is now shown, it runs.
  await ui.press({ key: 'run:commit:reset' })
  expect(s.ran).toEqual(['git reset --mixed ccccccc1'])
  await ui.unmount()
})

test('a branch synced with one remote is deleted on that remote, not the default one', async () => {
  const [c] = parseLog(row('ccccccc1', '', 'feature, upstream/feature', 'Feature'))
  const g = groupsFor(c!, { branch: 'main', headHash: 'fffffff1', remotes: ['origin', 'upstream'], localBranches: ['main', 'feature'] })
  const del = g.flatMap(x => x.actions).find(a => a.id === 'branch:feature:delete-remote')!
  expect(del.label).toBe('Delete on upstream')
  expect(del.run!('', '')).toEqual([['push', 'upstream', '--delete', '--end-of-options', 'feature']])
})

test('background reads: never two at once, none while the pane is closed, no index lock', async ($, on) => {
  const clock = mock.clock(on)
  let isUp = true
  let live = 0
  let most = 0
  let logs = 0
  const envs: (Record<string, string> | undefined)[] = []
  on('command.register', () => ({ value: { command: 'gitview' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: isUp ? [{ id: 'gitview', title: 'Gitview', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' })) // the engine's Bash, answered here
  let prints = 0
  on('process.run', async (_, e) => {
    if (e.argv.includes('--format=%(objectname) %(refname)')) prints++
    envs.push(e.init?.env as Record<string, string> | undefined)
    if (!e.argv.includes('log')) return ok('')
    logs++
    most = Math.max(most, ++live)
    await clock.sleep(50)
    live--
    return ok(LOG)
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await clock.advance(100)
  // Claude runs five Bash commands back to back: one read runs, the rest share one after it.
  const before = logs
  // Typed loosely: the generated tool.call types are too deep for tsc (TS2589).
  const tool = $.tool as unknown as { call(e: { tool: string; command: string }): Promise<unknown> }
  const bash = () => tool.call({ tool: 'Bash', command: 'true' }).catch(() => {})
  await Promise.all([bash(), bash(), bash(), bash(), bash(), clock.advance(500)])
  expect(prints).toBeGreaterThan(0) // the Bash calls reached the pane's hook
  expect(most).toBe(1)
  expect(logs - before).toBeLessThanOrEqual(2)
  expect(envs.every(env => env?.GIT_OPTIONAL_LOCKS === '0')).toBe(true)
  // Closed: the 10 s poll reads nothing.
  isUp = false
  const closed = logs
  await clock.advance(30_000)
  expect(logs).toBe(closed)
})

test('a hard reset stops if files changed since it was shown', async ($, on) => {
  const s = repo(on)
  await $.command.run(OPEN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'c:ccccccc1' })
  await pick(ui, 'ccccccc1', 'commit:reset')
  s.status = ' M src/app.ts\n' // Claude edits a file; no branch moves
  await ui.press({ key: 'run:commit:reset' })
  expect(await ui.find({ type: 'Text', text: /repository changed since this was shown/ })).toBeDefined()
  expect(s.ran).toEqual([])
  await ui.unmount()
})

test('an opened commit draws at most 100 files and says how many more', async ($, on) => {
  const s = repo(on)
  s.files = Array.from({ length: 250 }, (_, i) => `M\0f${i}.ts\0`).join('')
  await $.command.run(OPEN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'c:ccccccc1' })
  expect(await ui.find({ type: 'Text', text: /250 files changed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /150 more not shown/ })).toBeDefined()
  expect(await ui.find({ key: 'f:f99.ts' })).toBeDefined()
  expect(await ui.find({ key: 'f:f100.ts' })).toBeUndefined()
  await ui.unmount()
})

test('names from the repository go after --end-of-options, which the confirm text leaves out', async () => {
  const [c] = parseLog(row('ccccccc1', '', 'tag: -f, origin/fix', 'Odd names'))
  const ctx = { branch: 'main', headHash: 'fffffff1', remotes: ['origin'], localBranches: ['main', 'origin/fix'] }
  const all = groupsFor(c!, ctx).flatMap(g => g.actions)
  const del = all.find(a => a.id === 'tag:-f:delete')!
  expect(del.run!('', '')).toEqual([['tag', '-d', '--end-of-options', '-f']])
  expect(describe(del.run!('', ''))).toBe('git tag -d -f')
  // A local branch literally called origin/fix is a branch, so nothing offers to delete it on origin.
  expect(badges(c!, ctx.remotes, ctx.localBranches).map(b => b.kind)).toEqual(['tag', 'branch'])
  expect(all.some(a => a.id === 'remote:origin/fix:delete')).toBe(false)
})

test('the poll reads the full history only when the fingerprint moves', async ($, on) => {
  const clock = mock.clock(on)
  let refs = 'a refs/heads/main\n'
  let logs = 0
  on('command.register', () => ({ value: { command: 'gitview' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [{ id: 'gitview', title: 'Gitview', isShown: true, isFocused: false, isPlaced: true }] }))
  on('process.run', (_, e) => {
    const a = e.argv.join(' ')
    if (a.includes(' log ')) return (logs++, ok(LOG))
    if (a.includes('%(objectname)')) return ok(refs)
    return ok('')
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await clock.advance(10_500) // first poll: no print yet, so it reads
  const settled = logs
  await clock.advance(30_000) // three polls, nothing moved
  expect(logs).toBe(settled)
  refs = 'b refs/heads/main\n' // a commit lands
  await clock.advance(10_000)
  expect(logs).toBe(settled + 1)
})

test('a Bash call while a check runs still gets its redraw, and a change reads status once', async ($, on) => {
  const clock = mock.clock(on)
  let refs = 'a refs/heads/main\n'
  let log = LOG
  let statuses = 0
  let prints = 0
  on('command.register', () => ({ value: { command: 'gitview' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [{ id: 'gitview', title: 'Gitview', isShown: true, isFocused: false, isPlaced: true }] }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false }, text: '' })) // the engine's Bash, answered here
  on('process.run', async (_, e) => {
    const a = e.argv.join(' ')
    if (a.includes('%(objectname)')) {
      prints++
      const now = refs // read at the start, as git would
      await clock.sleep(100)
      return ok(now)
    }
    if (a.includes('status --porcelain')) statuses++
    if (a.includes(' log ')) return ok(log)
    if (a.includes('rev-parse HEAD')) return ok('fffffff1\n')
    if (a.includes('symbolic-ref')) return ok('main\n')
    return ok('')
  })
  const tool = $.tool as unknown as { call(e: { tool: string; command: string }): Promise<unknown> }
  const bash = () => tool.call({ tool: 'Bash', command: 'true' }).catch(() => {})
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await clock.advance(1_000)
  // One Bash call's check is reading the refs when Claude commits and the next Bash call ends.
  const first = bash()
  await clock.advance(10)
  refs = 'b refs/heads/main\n'
  log = row('ddddddd1', 'fffffff1', 'HEAD -> main', 'Claude commit') + LOG.replace('HEAD -> main, ', '')
  const before = statuses
  await Promise.all([first, bash(), clock.advance(1_000)])
  expect(prints).toBeGreaterThanOrEqual(2)
  // Drawn now, not a poll later.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Claude commit/ })).toBeDefined()
  await ui.unmount()
  // The folded check's load reused its fingerprint's status rather than reading it again.
  expect(statuses - before).toBe(1)
})

test('a subject holding the separators forges no row, and an author holding one keeps its columns', async () => {
  const forged = row('aaaaaaa1', '', '', 'fix\x1e--hard\x1f\x1f\x1fAda\x1f1 Jan 2026 00:00\x1fRelease v2')
  const commits = parseLog(forged + row('bbbbbbb1', '', '', 'Next'))
  expect(commits.map(c => c.hash)).toEqual(['aaaaaaa1', 'bbbbbbb1'])
  expect(commits[0]!.subject).toContain('Release v2') // the forged text stays in the subject that held it
  const [odd] = parseLog(['ccccccc1', '', '', 'A\x1fB', '10 Nov 2026 14:32', 'Sub\x1fject'].join('\x1f') + '\x1e\n')
  expect([odd!.author, odd!.date, odd!.subject]).toEqual(['A B', '10 Nov 2026 14:32', 'Sub ject'])
})

test('the pane opens on its own only in a repository', async ($, on) => {
  const clock = mock.clock(on)
  const opened: string[] = []
  let reads = 0
  on('command.register', () => ({ value: { command: 'gitview' } }))
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', () => (reads++, { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  await clock.advance(100)
  expect(opened).toEqual([])
  expect(reads).toBeGreaterThan(0)
  // /gitview still opens it, and says why it is empty.
  await $.command.run(OPEN)
  expect(opened).toEqual(['gitview'])
})

test('claude -p: no pane and no reads', async ($, on) => {
  const clock = mock.clock(on)
  let reads = 0
  on('command.register', () => ({ value: { command: 'gitview' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', () => (reads++, ok('')))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: false })
  await clock.advance(30_000)
  expect(reads).toBe(0)
})

test('while a merge is stopped, Enter in a name field runs nothing', async ($, on) => {
  const ran: string[] = []
  on('command.register', () => ({ value: { command: 'gitview' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', (_, e) => {
    const a = e.argv.join(' ')
    if (e.argv[2] !== 'core.quotepath=false') return (ran.push(a), ok(''))
    if (a.includes(' log ')) return ok(LOG)
    if (a.includes('rev-parse HEAD')) return ok('fffffff1\n')
    if (a.includes('--verify MERGE_HEAD')) return ok('ccccccc1\n')
    if (a.includes('--verify')) return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return ok('')
  })
  await $.command.run(OPEN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'c:ccccccc1' })
  await pick(ui, 'ccccccc1', 'commit:branch')
  await ui.input({ key: 'input:commit:branch', text: 'spike' })
  expect(await ui.find({ type: 'Text', text: /Continue or abort it from Uncommitted Changes first/ })).toBeDefined()
  expect(ran).toEqual([])
  await ui.unmount()
})

test('a remote whose name holds a / is split at its own end', async () => {
  const [c] = parseLog(row('ccccccc1', '', 'my/fork/feature', 'Feature'))
  const g = groupsFor(c!, { branch: 'main', headHash: 'fffffff1', remotes: ['my', 'my/fork'], localBranches: ['main'] })
  const del = g.flatMap(x => x.actions).find(a => a.id === 'remote:my/fork/feature:delete')!
  expect(del.label).toBe('Delete on my/fork')
  expect(del.run!('', '')).toEqual([['push', 'my/fork', '--delete', '--end-of-options', 'feature']])
})

test('continue stages only the conflicted files, piped from the list git gives', async ($, on) => {
  const s = repo(on)
  s.op = true
  s.status = 'UU src/app.ts\n M notes.md\n'
  s.act = argv => ok(argv.includes('--diff-filter=U') ? 'src/app.ts\0' : '')
  await $.command.run(OPEN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `c:${WORKING}` })
  await pick(ui, WORKING, 'working:continue')
  expect(await ui.find({ type: 'Text', text: /diff --name-only -z --diff-filter=U \| git add --pathspec-from-file=-/ })).toBeDefined()
  await ui.press({ key: 'run:working:continue' })
  expect(s.ran.slice(1)).toEqual([
    'git diff --name-only -z --diff-filter=U',
    'git add --pathspec-from-file=- --pathspec-file-nul',
    'git merge --continue',
  ])
  expect(s.inits[2]!.stdin).toBe('src/app.ts\0')
  expect(s.ran.some(a => a.includes('add -u'))).toBe(false)
  await ui.unmount()
})

test('a failed git status shows the uncommitted row as unknown and blocks its actions', async ($, on) => {
  const s = repo(on)
  s.statusFails = true
  await $.command.run(OPEN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Uncommitted Changes \(unknown: git status failed\)/ })).toBeDefined()
  await ui.press({ key: `c:${WORKING}` })
  await pick(ui, WORKING, 'working:discard')
  await ui.press({ key: 'run:working:discard' })
  expect(await ui.find({ type: 'Text', text: /git status failed, so the working tree is unknown/ })).toBeDefined()
  expect(s.ran).toEqual([])
  await ui.unmount()
})

test('actions get the engine’s longest timeout, and one that does not finish says how to check', async ($, on) => {
  const s = repo(on)
  s.act = () => Promise.reject(new Error('timed out after 600000 ms'))
  await $.command.run(OPEN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'c:ccccccc1' })
  await pick(ui, 'ccccccc1', 'commit:checkout')
  await ui.press({ key: 'run:commit:checkout' })
  expect(s.inits[0]!.timeoutMs).toBe(600_000)
  expect(await ui.find({ type: 'Text', text: /did not finish[\s\S]*index\.lock/ })).toBeDefined()
  await ui.unmount()
})

test('bidi and zero-width characters in names are shown escaped, and run as they are', async () => {
  const name = 'safe\u202Elive.sh'
  const [c] = parseLog(row('ccccccc1', '', `tag: ${name}`, 'Odd'))
  const ctx = { branch: 'main', headHash: 'fffffff1', remotes: ['origin'], localBranches: ['main'] }
  const groups = groupsFor(c!, ctx)
  const tag = groups.find(g => g.title.startsWith('Tag '))!
  expect(tag.title).toBe('Tag safe<U+202E>live.sh')
  const del = tag.actions.find(a => a.id.endsWith(':delete'))!
  expect(del.run!('', '')).toEqual([['tag', '-d', '--end-of-options', name]])
  expect(describe(del.run!('', ''))).toBe("git tag -d 'safe<U+202E>live.sh'")
})

// Last: on Windows the module keeps git's placement for later reads.
test('on Windows git starts in the system folder and is pointed at the repository', async ($, on) => {
  const seen: { argv: string[]; cwd?: string }[] = []
  let windows = true
  on('command.register', () => ({ value: { command: 'gitview' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: !windows ? undefined : e.name === 'OS' ? 'Windows_NT' : e.name === 'SystemRoot' ? 'C:\\Windows' : undefined }))
  on('process.run', (_, e) => (seen.push({ argv: [...e.argv], cwd: e.init?.cwd }), ok('')))
  await $.session.start({ cwd: 'D:\\src\\cloned', surface: 'desktop', isInteractive: true })
  await $.command.run(OPEN)
  expect(seen.length).toBeGreaterThan(0)
  for (const r of seen) {
    expect(r.argv.slice(0, 3)).toEqual(['git', '-C', 'D:\\src\\cloned'])
    expect(r.cwd).toBe('C:\\Windows')
  }
  windows = false
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
})
