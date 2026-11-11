import { pick } from './replay'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { groupsFor } from '../hooks/actions'
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
  row('mmmmmmm1', 'ccccccc1', 'HEAD -> main, origin/main', 'Second') +
  row('ccccccc1', '', '', 'First')

// A repository whose HEAD can be moved under the pane; every command is kept.
function repo(on: On) {
  const s = { head: 'mmmmmmm1', reads: [] as string[][], ran: [] as string[] }
  on('command.register', () => ({ value: { command: 'gitview' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    const a = e.argv.join(' ')
    if (e.argv[2] !== 'core.quotepath=false') {
      s.ran.push(a)
      return ok('')
    }
    s.reads.push([...e.argv])
    if (a.includes(' log ')) return ok(LOG)
    if (a.includes('rev-parse HEAD')) return ok(`${s.head}\n`)
    if (a.endsWith(' remote')) return ok('origin\n')
    if (a.includes('symbolic-ref')) return ok('main\n')
    if (a.includes(' show -s ')) return ok('Ada\x1fa@b.c\x1fdate\x1f\x1fFirst')
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
  s.head = 'zzzzzzz1' // Claude, or a terminal, moved the branch
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
  const g = groupsFor(c!, { branch: 'main', headHash: 'mmmmmmm1', remotes: ['origin', 'upstream'], localBranches: ['main', 'feature'] })
  const del = g.flatMap(x => x.actions).find(a => a.id === 'branch:feature:delete-remote')!
  expect(del.label).toBe('Delete on upstream')
  expect(del.run!('', '')).toEqual([['push', 'upstream', '--delete', 'feature']])
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
  on('ui.panes', () => ({ value: isUp ? [{ id: 'gitview', title: 'Gitview', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  on('process.run', async (_, e) => {
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
  const tool = $.tool as unknown as { call(e: { tool: string; input: unknown }): Promise<unknown> }
  const bash = () => tool.call({ tool: 'Bash', input: { command: 'true' } }).catch(() => {})
  await Promise.all([bash(), bash(), bash(), bash(), bash(), clock.advance(500)])
  expect(most).toBe(1)
  expect(logs - before).toBeLessThanOrEqual(2)
  expect(envs.every(env => env?.GIT_OPTIONAL_LOCKS === '0')).toBe(true)
  // Closed: the 10 s poll reads nothing.
  isUp = false
  const closed = logs
  await clock.advance(30_000)
  expect(logs).toBe(closed)
})
