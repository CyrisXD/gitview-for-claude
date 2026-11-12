import { findAction, pick } from './replay'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { describe, groupsFor } from '../hooks/actions'
import { parseLog } from '../hooks/graph'

// A typed /gitview; the rest of a real command.run input is left out.
const OPEN = { command: 'gitview', origin: { kind: 'composer' } } as Parameters<Engine['command']['run']>[0]

const row = (hash: string, parents: string, refs: string, subject: string) =>
  [hash, parents, refs, 'Ada', '10 Nov 2026 14:32', subject].join('\x1f') + '\x1e\n'
const LOG =
  row('fffffff1', 'bbbbbbb1 ccccccc1', 'HEAD -> main, origin/main', 'Merge feature') +
  row('ccccccc1', 'aaaaaaa1', 'feature, origin/feature', 'Add feature') +
  row('bbbbbbb1', 'aaaaaaa1', 'tag: v1.0, origin/old', 'Fix bug') +
  row('aaaaaaa1', '', '', 'Initial commit')
const CTX = { branch: 'main', headHash: 'fffffff1', remotes: ['origin'], localBranches: ['main', 'feature'] }

test('groups: commit, branch, tag and remote actions with the right commands', async () => {
  const [m, c, b] = parseLog(LOG)
  const head = groupsFor(m!, CTX)
  expect(head.map(g => g.title)).toEqual(['Commit fffffff', 'Branch main (checked out)'])
  // No merging, cherry-picking or resetting the checked-out commit onto itself.
  expect(head[0]!.actions.map(a => a.id)).not.toContain('commit:merge')
  expect(head[1]!.actions.map(a => a.id)).toContain('branch:main:pull')
  expect(head[1]!.actions.map(a => a.id)).not.toContain('branch:main:delete')

  const feature = groupsFor(c!, CTX)
  const del = feature[1]!.actions.find(a => a.id === 'branch:feature:delete')!
  expect(del.run!('', '-D')).toEqual([['branch', '-D', '--end-of-options', 'feature']])
  expect(feature[0]!.actions.find(a => a.id === 'commit:merge')!.run!('', '')).toEqual([['merge', '--no-edit', 'ccccccc1']])

  const tagged = groupsFor(b!, CTX)
  expect(tagged.map(g => g.title)).toEqual(['Commit bbbbbbb', 'Tag v1.0', 'Remote branch origin/old'])
  expect(tagged[2]!.actions.find(a => a.id === 'remote:origin/old:delete')!.run!('', '')).toEqual([['push', 'origin', '--delete', '--end-of-options', 'old']])
  expect(tagged[2]!.actions.map(a => a.id)).toContain('remote:origin/old:checkout')

  // A merge commit is cherry-picked and reverted against its first parent.
  const other = groupsFor(m!, { ...CTX, headHash: '77777771', branch: 'feature' })
  expect(other[0]!.actions.find(a => a.id === 'commit:revert')!.run!('', '')).toEqual([['revert', '--no-edit', '-m', '1', 'fffffff1']])
})

test('describe quotes words that need it', async () => {
  expect(describe([['stash', 'push', '-m', "it's wip"], ['clean', '-fd']])).toBe(`git stash push -m 'it'\\''s wip' && git clean -fd`)
})

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const PANE = {
  plugin: 'gitview', component: 'Pane', requestId: 'gitview',
  props: { title: 'Gitview', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the pane confirms an action, runs git and shows the result', async ($, on) => {
  const ran: string[] = []
  on('command.register', () => ({ value: { command: 'gitview' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const a = e.argv.join(' ')
    if (a.includes(' log ')) return ok(LOG)
    if (a.includes('rev-parse HEAD')) return ok('fffffff1\n')
    if (a.endsWith(' remote')) return ok('origin\n')
    if (a.includes('symbolic-ref')) return ok('main\n')
    if (a.includes('for-each-ref')) return ok('refs/heads/main\nrefs/heads/feature\n')
    if (a.includes(' show -s ')) return ok('Ada\x1fa@b.c\x1fdate\x1faaaaaaa1\x1fAdd feature')
    if (e.argv[1] === 'branch' || e.argv[1] === 'checkout') ran.push(a)
    return ok('')
  })
  await $.command.run(OPEN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'c:ccccccc1' })
  // The row's actions sit in one dropdown per group, each titled by its first entry.
  const menu = (await ui.find({ key: 'g:ccccccc1:Branch feature' })) as { props?: { options?: { label?: string }[]; value?: string } } | undefined
  expect(menu?.props?.options?.[0]?.label).toBe('Branch feature')
  expect(menu?.props?.value).toBe('-')

  // Delete asks first and shows the command; nothing runs until confirmed.
  await pick(ui, 'ccccccc1', 'branch:feature:delete')
  expect(await ui.find({ type: 'Text', text: 'git branch -d feature' })).toBeDefined()
  expect(((await ui.find({ key: 'g:ccccccc1:Branch feature' })) as { props?: { value?: string } })?.props?.value).toBe('branch:feature:delete') // shows what it is confirming
  expect(ran).toEqual([])
  await ui.press({ key: 'run:branch:feature:delete' })
  expect(ran).toEqual(['git branch -d --end-of-options feature'])
  expect(await ui.find({ type: 'Text', text: /Delete: done/ })).toBeDefined()

  // An input action runs with what was typed.
  await pick(ui, 'ccccccc1', 'commit:branch')
  await ui.input({ key: 'input:commit:branch', text: 'spike' })
  expect(ran.at(-1)).toBe('git checkout -b spike ccccccc1')
  await ui.unmount()
})

test('a stopped operation offers continue and abort on the uncommitted row', async () => {
  const working = { kind: 'working' as const, hash: 'WORKING', parents: ['fffffff1'], refs: [], author: '*', date: '*', subject: 'Uncommitted Changes (1)' }
  expect(groupsFor(working, CTX)[0]!.actions.map(a => a.id)).toEqual(['working:stash', 'working:discard'])
  const acts = groupsFor(working, { ...CTX, operation: 'cherry-pick' })[0]!.actions
  expect(acts.find(a => a.id === 'working:abort')!.run!('', '')).toEqual([['cherry-pick', '--abort']])
  expect(acts.find(a => a.id === 'working:continue')!.run!('', '')).toEqual([
    ['-c', 'core.whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab', 'diff', '--check', 'HEAD'],
    ['diff', '--name-only', '-z', '--diff-filter=U'],
    ['add', '--pathspec-from-file=-', '--pathspec-file-nul'],
    ['cherry-pick', '--continue'],
  ])
})

test('while a merge is stopped, other actions point to continue or abort', async ($, on) => {
  on('command.register', () => ({ value: { command: 'gitview' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', (_, e) => {
    const a = e.argv.join(' ')
    if (a.includes(' log ')) return ok(LOG)
    if (a.includes('rev-parse HEAD')) return ok('fffffff1\n')
    if (a.endsWith(' remote')) return ok('origin\n')
    if (a.includes('symbolic-ref')) return ok('main\n')
    if (a.includes('--verify MERGE_HEAD')) return ok('ccccccc1\n')
    if (a.includes('--verify')) return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (a.includes('status --porcelain')) return ok('UU src/app.js\n')
    return ok('')
  })
  await $.command.run(OPEN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /merge stopped on a conflict/ })).toBeDefined()
  await ui.press({ key: 'c:ccccccc1' })
  await pick(ui, 'ccccccc1', 'commit:revert')
  expect(await ui.find({ key: 'run:commit:revert' })).toBeUndefined()
  await ui.press({ key: 'c:WORKING' })
  await pick(ui, 'WORKING', 'working:abort')
  expect(await ui.find({ key: 'run:working:abort' })).toBeDefined()
})
