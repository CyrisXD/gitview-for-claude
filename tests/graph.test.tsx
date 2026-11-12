import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { hunks, parseChanges } from '../hooks/git'
import { badges, layout, merge, parseLog, rowSvg } from '../hooks/graph'

// A typed /gitview; the rest of a real command.run input is left out.
const OPEN = { command: 'gitview', origin: { kind: 'composer' } } as Parameters<Engine['command']['run']>[0]

const row = (hash: string, parents: string, refs: string, subject: string) =>
  [hash, parents, refs, 'Ada', '10 Nov 2026 14:32', subject].join('\x1f') + '\x1e\n'

// main: A - B - M (merge of feature C); feature: A - C
const LOG =
  row('fffffff1', 'bbbbbbb1 ccccccc1', 'HEAD -> main, origin/main, origin/HEAD', 'Merge feature') +
  row('ccccccc1', 'aaaaaaa1', 'origin/feature', 'Add feature') +
  row('bbbbbbb1', 'aaaaaaa1', 'tag: v1.0', 'Fix bug') +
  row('aaaaaaa1', '', '', 'Initial commit')
const STASH = row('eeeeeee1', 'bbbbbbb1 99999991', 'stash@{0}', 'On main: wip')

test('lanes: a branch splits off a merge and converges at its base', async () => {
  const commits = parseLog(LOG)
  const { cols, lanes, edges } = layout(commits)
  expect(cols).toEqual([0, 1, 0, 0])
  expect(lanes).toBe(2)
  expect(edges.filter(e => e.r1 === 0).map(e => [e.x1, e.x2])).toEqual([[0, 0], [0, 1]])
  expect(edges.filter(e => e.r1 === 2).map(e => [e.x1, e.x2])).toEqual([[0, 0], [1, 0]])
})

test('stashes sit above their base and uncommitted changes on top', async () => {
  const working = { kind: 'working' as const, hash: 'WORKING', parents: ['fffffff1'], refs: [], author: '*', date: '*', subject: 'Uncommitted Changes (1)' }
  const all = merge(parseLog(LOG), parseLog(STASH, 'stash'), working)
  expect(all.map(c => c.hash)).toEqual(['WORKING', 'fffffff1', 'ccccccc1', 'eeeeeee1', 'bbbbbbb1', 'aaaaaaa1'])
  expect(all[3]!.parents).toEqual(['bbbbbbb1']) // index commit dropped
  const lay = layout(all)
  // Each row's slice: a line arriving at row 1 from the working row above.
  expect(rowSvg(all, lay, 1, true)).toContain('M10 0V14')
})

test('badges: local and remote twins merge, remote HEAD and orphans', async () => {
  const [m, c, b] = parseLog(LOG)
  expect(badges(m!, ['origin'])).toEqual([{ label: 'main', kind: 'head', isSynced: true }])
  expect(badges(c!, ['origin'])).toEqual([{ label: 'origin/feature', kind: 'remote', isSynced: false }])
  expect(badges(b!, ['origin'])).toEqual([{ label: 'v1.0', kind: 'tag', isSynced: false }])
})

test('file changes join name-status and numstat, renames included', async () => {
  const files = parseChanges('M\0a.ts\0R090\0old.ts\0new.ts\0', '3\t1\ta.ts\0' + '2\t2\t\0old.ts\0new.ts\0')
  expect(files).toEqual([
    { status: 'M', path: 'a.ts', added: 3, removed: 1 },
    { status: 'R', oldPath: 'old.ts', path: 'new.ts', added: 2, removed: 2 },
  ])
})

const PANE = {
  plugin: 'gitview',
  component: 'Pane',
  requestId: 'gitview',
  props: { title: 'Gitview', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

function fakeGit(on: On, log: () => string) {
  on('process.run', (_, e) => {
    const a = e.argv.join(' ')
    if (a.includes(' log ')) return ok(log())
    if (a.includes('%(objectname)')) return ok(log()) // the poll's fingerprint moves with the history
    if (a.includes('stash list')) return ok(STASH)
    if (a.includes('status --porcelain')) return ok(' M src/app.ts\n')
    if (a.includes('rev-parse HEAD')) return ok('fffffff1\n')
    if (a.endsWith(' remote')) return ok('origin\n')
    if (a.includes('--name-status')) return ok('M\0src/app.ts\0')
    if (a.includes('--numstat')) return ok('4\t1\tsrc/app.ts\0')
    if (a.includes(' show -s ')) return ok('Ada\x1fada@example.com\x1fTue, 10 Nov 2026\x1fbbbbbbb1 ccccccc1\x1fMerge feature\n\nLong body')
    if (a.includes('ls-files')) return ok('')
    if (a.includes('--no-textconv -M ')) return ok('@@ -1,1 +1,1 @@\n-old\n+new\n')
    return ok('')
  })
}

test('rows, details and a diff on desktop; polling picks up new commits', async ($, on) => {
  const clock = mock.clock(on)
  let log = LOG
  on('command.register', () => ({ value: { command: 'gitview' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.panes', () => ({ value: [{ id: 'gitview', title: 'Gitview', isShown: true, isFocused: false, isPlaced: true }] }))
  fakeGit(on, () => log)

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.command.run(OPEN)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Rows 1–6 of 6/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Uncommitted Changes \(1\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /On main: wip/ })).toBeDefined()

  await ui.press({ key: 'c:fffffff1' })
  expect(await ui.find({ type: 'Text', text: /Long body/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 file changed/ })).toBeDefined()

  await ui.press({ key: 'f:src/app.ts' })
  expect(await ui.find({ type: 'Code' })).toBeDefined()

  await ui.press({ key: 'c:fffffff1' }) // collapses
  expect(await ui.find({ type: 'Text', text: /Long body/ })).toBeUndefined()
  await ui.unmount()

  log = row('ddddddd1', 'fffffff1', 'HEAD -> main', 'New work') + LOG.replace('HEAD -> main, ', '')
  await clock.advance(10_000)
  const later = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await later.find({ type: 'Text', text: /Rows 1–7 of 7/ })).toBeDefined()
  expect(await later.find({ type: 'Text', text: /New work/ })).toBeDefined()
  await later.unmount()
})

test('VS Code: the pane never opens, and a pane shown there is only a note', async ($, on) => {
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'gitview' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  fakeGit(on, () => LOG)

  await $.session.start({ cwd: '/repo', surface: 'vscode', isInteractive: true })
  expect((await $.command.run(OPEN)).text).toMatch(/terminal and the Claude desktop app/)
  expect(opened).toEqual([])

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await ui.find({ type: 'Text', text: /use a git graph extension/ })).toBeDefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('outside a repository the pane says so', async ($, on) => {
  on('command.register', () => ({ value: { command: 'gitview' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', () => ({
    value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  await $.command.run(OPEN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /not a git repository/ })).toBeDefined()
  await ui.unmount()
})

test('diff text keeps only the hunks the Code element parses', async () => {
  const head = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n'
  expect(hunks(head + '@@ -1 +1 @@\n-a\n+b\n')).toBe('@@ -1 +1 @@\n-a\n+b\n')
  expect(hunks('diff --git a/u b/m\nsimilarity index 100%\nrename from u\nrename to m\n')).toBe('')
})
