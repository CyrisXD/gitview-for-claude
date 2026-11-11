import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import branchCheckoutNew from './fixtures/branch-checkout-new'
import branchDeleteForce from './fixtures/branch-delete-force'
import branchLife from './fixtures/branch-life'
import browse from './fixtures/browse'
import commitOps from './fixtures/commit-ops'
import discardAll from './fixtures/discard-all'
import discardTracked from './fixtures/discard-tracked'
import mergeConflict from './fixtures/merge-conflict'
import mergeContinue from './fixtures/merge-continue'
import mergeContinueResolved from './fixtures/merge-continue-resolved'
import pull from './fixtures/pull'
import remoteBranches from './fixtures/remote-branches'
import stashApplyDirty from './fixtures/stash-apply-dirty'
import stashOps from './fixtures/stash-ops'
import stashPop from './fixtures/stash-pop'
import stashPopIndex from './fixtures/stash-pop-index'
import stashPush from './fixtures/stash-push'
import tags from './fixtures/tags'
import { dividers, dragTo } from '../hooks/columns'
import { WIDTHS, shortDate } from '../hooks/register'
import { badgeStyle, badgeSvg } from '../hooks/graph'
import { PANE, act, badge, dump, goTo, replay, findAction, pick } from './replay'

type Fx = Parameters<typeof replay>[1]
// The fields a typed /gitview carries; the pane reads none of them.
const open = ($: Engine) => $.command.run({ command: 'gitview', origin: { kind: 'composer' } } as unknown as Parameters<Engine['command']['run']>[0])
const ALL: Fx[] = [
  stashPop, stashPopIndex, stashApplyDirty, stashOps, stashPush, discardTracked, discardAll, branchLife, branchCheckoutNew,
  branchDeleteForce, remoteBranches, tags, pull, commitOps, mergeConflict, mergeContinue, mergeContinueResolved,
]

// Every recorded flow, done through the pane: the commands it runs are the
// recording's, each step ends in a done or failed line, and a failure shows git's words.
for (const fx of ALL) {
  test(`flow ${fx.name}: the pane runs what git ran and reports each step`, async ($, on) => {
    const log = replay(on, fx)
    await open($)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    for (let i = 0; i < fx.steps.length; i++) {
      const st = fx.steps[i]!
      await act(ui, fx, i)
      const failed = st.results.at(-1)!.exitCode !== 0
      expect(await ui.find({ type: 'Text', text: failed ? / failed$|stopped on a conflict/ : /: done/ })).toBeDefined()
      if (failed) {
        const last = st.results.at(-1)!
        const words = (last.stderr.trim() || last.stdout.trim()).split('\n')[0]!
        expect(await ui.find({ type: 'Text', text: words })).toBeDefined()
        await ui.press({ key: `cancel:${st.action}` })
      }
    }
    expect(log.ran).toEqual(fx.steps.flatMap(s => s.argv.map(a => a.join(' '))))
    expect([log.missing, log.unexpected]).toEqual([[], []])
    await ui.unmount()
  })
}

const mount = async ($: Engine, on: Parameters<typeof replay>[0], fx: Fx) => {
  const log = replay(on, fx)
  await open($)
  return { log, ui: await $.ui.mount({ ...PANE, surface: 'desktop' }) }
}

test('stash pop: the stash row goes and its file joins the uncommitted changes', async ($, on) => {
  const { ui } = await mount($, on, stashPop)
  const hash = stashPop.steps[0].hash
  expect(await ui.find({ type: 'Text', text: 'Uncommitted Changes (4)' })).toBeDefined()
  await act(ui, stashPop, 0)
  expect(await ui.find({ key: `c:${hash}` })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Uncommitted Changes (5)' })).toBeDefined()
})

test('the header: refresh and count on one line, the result on its own, a rule under it', async ($, on) => {
  const { ui } = await mount($, on, stashPop)
  await act(ui, stashPop, 0)
  expect((await ui.find({ type: 'Text', text: /^Rows 1–/ }))?.text).toMatch(/ · on main$/)
  expect(await ui.find({ type: 'Text', text: /^Pop: done/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^─+$/ }))?.text?.length).toBe(120)
})

test('paging: older and newer windows cover every row once', async ($, on) => {
  const { ui } = await mount($, on, browse)
  const label = async () => (await ui.find({ type: 'Text', text: /^Rows / }))!.text!
  const first = await label()
  expect(first).toMatch(/^Rows 1–\d+ of 69 · on main$/)
  expect(await ui.find({ key: 'newer' })).toBeUndefined()
  await ui.press({ key: 'older' })
  const end = Number(first.match(/–(\d+)/)![1])
  expect(await label()).toBe(`Rows ${end + 1}–69 of 69 · on main`)
  expect(await ui.find({ key: 'older' })).toBeUndefined()
  await ui.press({ key: 'newer' })
  expect(await label()).toBe(first)
})

test('copy actions put the hash, subject and names on the clipboard', async ($, on) => {
  const { ui, log } = await mount($, on, browse)
  const main = '5aa06563723be6ea146d1f64abf83299b83b2c33'
  await ui.press({ key: `c:${main}` })
  await pick(ui, main, `commit:copy-hash`)
  await pick(ui, main, `commit:copy-subject`)
  await pick(ui, main, `branch:main:copy`)
  expect(log.copied).toEqual([main, 'Add licence section', 'main'])
  expect(log.toasts).toContain('Copied Add licence section')
  expect(log.ran).toEqual([])
})

test('create branch: the Then choice decides between branch and checkout -b', async ($, on) => {
  const { ui, log } = await mount($, on, branchLife)
  const main = branchLife.steps[0].hash
  await ui.press({ key: `c:${main}` })
  await pick(ui, main, `commit:branch`)
  // The command line shows a placeholder until a name is typed, then follows the choice.
  expect(await ui.find({ type: 'Text', text: `git checkout -b '<branch name>' ${main}` })).toBeDefined()
  await ui.select({ key: 'choice:commit:branch', value: 'stay' })
  expect(await ui.find({ type: 'Text', text: `git branch '<branch name>' ${main}` })).toBeDefined()
  // Enter with no name refuses without running git.
  await ui.input({ key: 'input:commit:branch', text: '' })
  expect(await ui.find({ type: 'Text', text: 'Branch name is required.' })).toBeDefined()
  expect(log.ran).toEqual([])
  await ui.input({ key: 'input:commit:branch', text: 'spike' })
  expect(log.ran).toEqual([`git branch spike ${main}`])
  expect(await badge(ui, 'spike')).toBeDefined()
})

test('branch life: push gives a synced badge, rename and both deletes follow', async ($, on) => {
  const { ui } = await mount($, on, branchLife)
  for (let i = 0; i < 2; i++) await act(ui, branchLife, i)
  expect(await badge(ui, 'spike ⇅')).toBeDefined()
  await act(ui, branchLife, 2)
  expect(await badge(ui, 'spike-2')).toBeDefined()
  expect(await badge(ui, 'origin/spike')).toBeDefined()
  await act(ui, branchLife, 3)
  expect(await badge(ui, 'spike-2')).toBeUndefined()
  await act(ui, branchLife, 4)
  expect(await badge(ui, 'origin/spike')).toBeUndefined()
})

test('delete: only-if-merged fails on an unmerged branch, force deletes it', async ($, on) => {
  const { ui } = await mount($, on, branchDeleteForce)
  await act(ui, branchDeleteForce, 0)
  expect(await ui.find({ type: 'Text', text: /not fully merged/ })).toBeDefined()
  await ui.press({ key: 'cancel:branch:experiment/local-only:delete' })
  await act(ui, branchDeleteForce, 1)
  expect(await badge(ui, 'experiment/local-only')).toBeUndefined()
})

test('a remote-only branch checks out as a tracking local branch', async ($, on) => {
  const { ui } = await mount($, on, remoteBranches)
  await goTo(ui, async () => !!(await badge(ui, 'origin/feature/old-api')))
  expect(await badge(ui, 'origin/feature/old-api')).toBeDefined()
  await act(ui, remoteBranches, 0)
  expect(await badge(ui, 'feature/old-api ⇅')).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^Rows / }))?.text).toMatch(/on feature\/old-api$/)
  await act(ui, remoteBranches, 1)
  expect(await badge(ui, 'feature/login')).toBeDefined()
  expect(await badge(ui, 'feature/login ⇅')).toBeUndefined()
})

test('tags: add, push and delete', async ($, on) => {
  const { ui } = await mount($, on, tags)
  for (let i = 0; i < 3; i++) await act(ui, tags, i)
  expect(await badge(ui, 'v2.0')).toBeDefined()
  await act(ui, tags, 3)
  expect(await badge(ui, 'v2.0')).toBeUndefined()
})

test('discard: tracked only keeps untracked files, all removes them', async ($, on) => {
  const one = await mount($, on, discardTracked)
  await act(one.ui, discardTracked, 0)
  expect(await one.ui.find({ type: 'Text', text: 'Uncommitted Changes (2)' })).toBeDefined()
})

test('discard all leaves no uncommitted row', async ($, on) => {
  const { ui } = await mount($, on, discardAll)
  await act(ui, discardAll, 0)
  expect(await ui.find({ key: 'c:WORKING' })).toBeUndefined()
})

test('reset: soft, mixed and hard each move the branch as asked', async ($, on) => {
  const { ui, log } = await mount($, on, commitOps)
  for (let i = 0; i < commitOps.steps.length; i++) await act(ui, commitOps, i)
  expect(log.ran.filter(a => a.startsWith('git reset'))).toEqual([
    'git reset --soft dfe907039bbc119d818242e970df71a5aeddcd58',
    'git reset --mixed 5aa06563723be6ea146d1f64abf83299b83b2c33',
    'git reset --hard dfe907039bbc119d818242e970df71a5aeddcd58',
  ])
  // The mixed reset left the picked file untracked, and a hard reset keeps untracked files.
  await goTo(ui, async () => !!(await ui.find({ key: 'c:WORKING' })))
  await ui.press({ key: 'c:WORKING' })
  expect(await ui.find({ key: 'f:src/wild.js' })).toBeDefined()
})

test('a merge conflict: notice, conflicted file marked, abort clears it', async ($, on) => {
  const { ui } = await mount($, on, mergeConflict)
  await act(ui, mergeConflict, 0)
  expect(await ui.find({ type: 'Text', text: /merge stopped on a conflict/ })).toBeDefined()
  await ui.press({ key: 'cancel:branch:feature/search:merge' })
  await ui.press({ key: 'c:WORKING' })
  expect(await ui.find({ type: 'Text', text: /^U$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^conflict$/ })).toBeDefined()
  await act(ui, mergeConflict, 1)
  expect(await ui.find({ type: 'Text', text: /merge stopped/ })).toBeUndefined()
})

test('continue refuses while conflict markers remain, before staging anything', async ($, on) => {
  const { ui, log } = await mount($, on, mergeContinue)
  await act(ui, mergeContinue, 0)
  expect(log.ran).toEqual(['git -c core.whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab diff --check HEAD'])
  expect(await ui.find({ type: 'Text', text: /leftover conflict marker/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /merge stopped on a conflict/ })).toBeDefined()
})

test('continue on a resolved merge commits it and the notice goes', async ($, on) => {
  const { ui } = await mount($, on, mergeContinueResolved)
  await act(ui, mergeContinueResolved, 0)
  expect(await ui.find({ type: 'Text', text: /merge stopped/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: "Merge branch 'feature/search'" })).toBeDefined()
})

test('a long git error is cut to its first lines', async ($, on) => {
  const { ui } = await mount($, on, stashApplyDirty)
  await act(ui, stashApplyDirty, 0)
  const err = await ui.find({ type: 'Text', text: /^Auto-merging src\/app.js/ })
  expect(err?.text?.split('\n').length).toBe(9)
  expect(err?.text?.endsWith('…')).toBe(true)
  expect(await ui.find({ type: 'Text', text: 'Apply stopped on a conflict: resolve it in Uncommitted Changes' })).toBeDefined()
  await ui.press({ key: 'cancel:stash:apply' })
  await ui.press({ key: 'c:WORKING' })
  expect(await ui.find({ type: 'Text', text: /^conflict$/ })).toBeDefined()
})

test('pop can restore what was staged', async ($, on) => {
  const { ui, log } = await mount($, on, stashPopIndex)
  await act(ui, stashPopIndex, 0)
  expect(log.ran).toEqual(['git stash pop --index stash@{0}'])
  // git's own status after the pop: src/app.js staged again, src/math.js not.
  const status = (stashPopIndex.states[1] as Record<string, { stdout: string }>)[JSON.stringify(['git', '-c', 'core.quotepath=false', 'status', '--porcelain'])]!.stdout
  expect(status).toContain('M  src/app.js')
  expect(status).toContain(' M src/math.js')
})

test('pop leaves changes unstaged by default and says so in its choice', async ($, on) => {
  const { ui } = await mount($, on, stashPop)
  const h = stashPop.steps[0].hash
  await ui.press({ key: `c:${h}` })
  await pick(ui, h, `stash:pop`)
  expect(await ui.find({ type: 'Text', text: 'git stash pop stash@{0}' })).toBeDefined()
  await ui.select({ key: 'choice:stash:pop', value: 'index' })
  expect(await ui.find({ type: 'Text', text: 'git stash pop --index stash@{0}' })).toBeDefined()
})

// What the desktop paints is not visible to a test, but what it is asked to paint is.
type Node = { type: string; props?: Record<string, unknown>; children?: unknown[] }
const walk = (n: unknown, inButton: boolean, out: { node: Node; inButton: boolean }[]) => {
  if (!n || typeof n !== 'object') return out
  if (Array.isArray(n)) return n.forEach(x => walk(x, inButton, out)), out
  const node = n as Node
  out.push({ node, inButton })
  for (const k of node.children ?? []) walk(k, inButton || node.type === 'Button', out)
  return out
}

test('paint: the rule is dim, conflict and file letters are coloured, and no colour sits inside a Button', async ($, on) => {
  const { ui } = await mount($, on, mergeConflict)
  await act(ui, mergeConflict, 0)
  await ui.press({ key: 'cancel:branch:feature/search:merge' })
  await ui.press({ key: 'c:WORKING' })
  const all = walk(await ui.find({ type: 'Box' }), false, [])
  const text = (t: RegExp) => all.find(x => x.node.type === 'Text' && t.test(String(x.node.children?.join(''))))!
  expect(text(/^─+$/).node.props).toMatchObject({ dimColor: true })
  expect(text(/^U$/).node.props).toMatchObject({ color: '#d0605e' })
  expect(text(/^conflict$/).node.props).toMatchObject({ color: '#d0605e' })
  expect(text(/^A$/).node.props).toMatchObject({ color: '#629987' })
  // The desktop drops colour on a Button's Text children (seen in the pane before), so none may carry one.
  expect(all.filter(x => x.inButton && x.node.type === 'Text' && (x.node.props?.color || x.node.props?.backgroundColor))).toEqual([])
  for (const x of all.filter(x => x.inButton)) expect(x.node.type === 'Button' || x.node.type === 'Text').toBe(true)
})

test('paint: Pop and Apply draw the Staged changes Select with both options', async ($, on) => {
  const { ui } = await mount($, on, stashPop)
  const h = stashPop.steps[0].hash
  await ui.press({ key: `c:${h}` })
  for (const id of ['stash:pop', 'stash:apply']) {
    await pick(ui, h, `${id}`)
    const sel = (await ui.find({ key: `choice:${id}` })) as unknown as Node
    expect(sel.type).toBe('Select')
    expect(sel.props).toMatchObject({ label: 'Staged changes', value: 'unstaged' })
    expect((sel.props!.options as { value: string }[]).map(o => o.value)).toEqual(['unstaged', 'index'])
    await ui.press({ key: `cancel:${id}` })
  }
})

test('a draw that reads the view from before a press does not lose the opened details', async ($, on) => {
  // A live session can draw from a read taken before a handler's latest write landed (seen in a
  // terminal session: a commit's details stayed on Loading…). Stage it: the details' git read
  // waits on the clock, and a draw in that gap gets the view from before the press.
  const clock = mock.clock(on)
  let older: unknown
  let last: unknown
  let stale = false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on('state.get', async (_: unknown, e: any, next: any) => {
    const read = await next(e)
    if (e.key !== 'view') return read
    if (!stale) return (last = read)
    stale = false
    return older
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on('state.set', async (_: unknown, e: any, next: any) => {
    if (e.key === 'view') [older, stale] = [last, false]
    return next(e)
  })
  replay(on, browse, { clock, when: argv => (argv.includes('show') ? 1000 : 0) })
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const main = '5aa06563723be6ea146d1f64abf83299b83b2c33'
  const pressed = ui.press({ key: `c:${main}` })
  await clock.advance(10) // the press has written the view and is waiting on git show
  stale = true
  await (await $.ui.mount({ ...PANE, surface: 'terminal' })).unmount() // a second surface draws meanwhile
  expect(stale).toBe(false) // that draw did read the old view
  await clock.advance(1000)
  await pressed
  expect(await ui.find({ type: 'Text', text: 'Loading…' })).toBeUndefined()
  expect(await findAction(ui, main, `commit:copy-hash`)).toBeDefined()
})

test('an empty optional stash message is left out of the command shown', async ($, on) => {
  const { ui } = await mount($, on, stashPush)
  await ui.press({ key: 'c:WORKING' })
  await pick(ui, 'WORKING', 'working:stash')
  expect(await ui.find({ type: 'Text', text: /^git stash push -u$/ })).toBeDefined()
  await ui.select({ key: 'choice:working:stash', value: 'no' })
  expect(await ui.find({ type: 'Text', text: /^git stash push$/ })).toBeDefined()
})

test('mobile: choices are buttons, a name cannot be typed, an optional one can be left out', async ($, on) => {
  const log = replay(on, stashPush)
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  await ui.press({ key: 'c:WORKING' })
  await pick(ui, 'WORKING', 'working:stash')
  await ui.press({ key: 'choice:working:stash:no' })
  expect(await ui.find({ type: 'Text', text: /^git stash push$/ })).toBeDefined()
  await ui.press({ key: 'run:working:stash' })
  expect(log.unexpected).toEqual(['git stash push']) // the recording stashed with -u and a message
})

test('mobile: an action that needs a name says where to type it and offers no Run', async ($, on) => {
  replay(on, browse)
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  const main = '5aa06563723be6ea146d1f64abf83299b83b2c33'
  await ui.press({ key: `c:${main}` })
  await pick(ui, main, `commit:tag`)
  expect(await ui.find({ type: 'Text', text: 'Tag name can be typed in the terminal or the desktop app.' })).toBeDefined()
  expect(await ui.find({ key: 'run:commit:tag' })).toBeUndefined()
})

test('search: rows narrow to every word of it in subject, author, hash or refs, and Clear brings them back', async ($, on) => {
  replay(on, browse)
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const main = 'c:5aa06563723be6ea146d1f64abf83299b83b2c33'
  const divide = 'c:dfe907039bbc119d818242e970df71a5aeddcd58'
  const bulk30 = 'c:6c0d8bd15f047f460b77a586511755afb04fa794'
  // Each keystroke filters (a change, no Enter).
  await ui.input({ key: 'filter', text: 'DIVIDE', kind: 'change' })
  expect(await ui.find({ key: divide })).toBeDefined()
  expect(await ui.find({ key: main })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^1–1 of 1 matching “DIVIDE”/ })).toBeDefined()
  // Two words: a branch name and a subject word, both needed.
  await ui.input({ key: 'filter', text: 'many-commits bulk', kind: 'change' })
  expect(await ui.find({ key: bulk30 })).toBeDefined()
  expect(await ui.find({ key: 'c:4b69294c3d6933be27cc962e505df6fe82ee7439' })).toBeUndefined()
  // A hash prefix finds its commit.
  await ui.input({ key: 'filter', text: '5aa0656', kind: 'change' })
  expect(await ui.find({ key: main })).toBeDefined()
  await ui.input({ key: 'filter', text: 'licence divide', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /^Nothing matches “licence divide”/ })).toBeDefined()
  await ui.press({ key: 'filter:clear' })
  expect(await ui.find({ key: main })).toBeDefined()
  expect(await ui.find({ key: divide })).toBeDefined()
  expect(await ui.find({ key: 'filter:clear' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Rows 1–/ })).toBeDefined()
})

test('search: an opened row stays open while it matches', async ($, on) => {
  replay(on, browse)
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const main = '5aa06563723be6ea146d1f64abf83299b83b2c33'
  await ui.press({ key: `c:${main}` })
  await ui.input({ key: 'filter', text: 'licence', kind: 'change' })
  expect(await findAction(ui, main, `commit:tag`)).toBeDefined()
})

test('mobile: no search field, since it has no fields', async ($, on) => {
  replay(on, browse)
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await ui.find({ key: 'filter' })).toBeUndefined()
})

test('refresh (terminal): the icon dims while it runs, then the status line says whether anything changed and when', async ($, on) => {
  const clock = mock.clock(on)
  const log = replay(on, stashPop)
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const pressed = ui.press({ key: 'refresh' })
  await clock.advance(10)
  expect(await ui.find({ key: 'refresh', text: '…' })).toBeDefined()
  // A second press while it runs does nothing.
  await ui.press({ key: 'refresh' })
  await clock.advance(400)
  await pressed
  expect(await ui.find({ key: 'refresh', text: '↻' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ · ✓ Up to date · \d\d:\d\d:\d\d$/ })).toBeDefined()
  // git changed outside the pane (the stash popped in a terminal): the next refresh says Updated.
  log.state = 1
  const again = ui.press({ key: 'refresh' })
  await clock.advance(400)
  await again
  expect(await ui.find({ type: 'Text', text: /^ · ✓ Updated · / })).toBeDefined()
  expect(await ui.find({ key: 'c:' + stashPop.steps[0]!.hash })).toBeUndefined()
})

// The widths the heads are drawn at (each a Box keyed head:<column> in the Client).
type Found = { props?: Record<string, unknown> } | undefined
const drawn = async (ui: { find(q: object): Promise<Found> }) => {
  const at = async (col: string) => (await ui.find({ key: `head:${col}`, in: 'columns' }))?.props?.width
  return { date: await at('date'), author: await at('author'), commit: await at('commit') }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`columns (${surface}): dragging a divider resizes its column, and it clamps`, async ($, on) => {
    replay(on, browse)
    await open($)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.resize({ columns: 114, rows: 1, in: 'columns' })
    // 114 across: Commit's divider at 105, Author's at 90, Date's at 72.
    expect(await drawn(ui)).toEqual({ date: 17, author: 14, commit: 8 })
    const drag = async (from: number, to: number) => {
      await ui.pointer({ type: 'down', x: from, y: 0, button: 'left', in: 'columns' })
      await ui.pointer({ type: 'move', x: to, y: 0, button: 'left', in: 'columns' })
      await ui.pointer({ type: 'up', x: to, y: 0, button: 'left', in: 'columns' })
    }
    // Pressing away from a divider picks nothing up.
    await drag(40, 30)
    expect(await drawn(ui)).toEqual({ date: 17, author: 14, commit: 8 })
    // Mid-drag the dragged head says its width (the desktop redraws the rows only on release).
    await ui.pointer({ type: 'down', x: 90, y: 0, button: 'left', in: 'columns' })
    await ui.pointer({ type: 'move', x: 85, y: 0, button: 'left', in: 'columns' })
    expect(await ui.find({ type: 'Text', text: 'Author · 19', in: 'columns' })).toBeDefined()
    await ui.pointer({ type: 'up', x: 85, y: 0, button: 'left', in: 'columns' })
    expect(await ui.find({ type: 'Text', text: /^Author$/, in: 'columns' })).toBeDefined()
    await drag(86, 90) // back to 14
    // Author's divider dragged 10 left (one cell off still catches it).
    await drag(91, 81)
    expect(await drawn(ui)).toEqual({ date: 17, author: 23, commit: 8 })
    // A redraw from the pane's own state keeps the widths (they were stored, not only shown),
    // and the rows are drawn at them too.
    await ui.redraw()
    expect(await drawn(ui)).toEqual({ date: 17, author: 23, commit: 8 })
    // Date dragged far left stops at 60 wide.
    await drag(62, 0)
    expect((await drawn(ui)).date).toBe(60)
  })
}

test('columns: a message with junk widths is clamped, not stored as is', async ($, on) => {
  replay(on, browse)
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.resize({ columns: 114, rows: 1, in: 'columns' })
  await ui.post({ widths: { date: 'x', author: -5, commit: 1e9 } }, { in: 'columns' })
  expect(await drawn(ui)).toEqual({ date: 17, author: 4, commit: 60 })
})

test('columns: where no Client is drawn (mobile) the heads are plain and Author is there', async ($, on) => {
  replay(on, browse)
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await ui.find({ type: 'Text', text: /^Author$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Commit$/ })).toBeDefined()
})

test('columns: a drag stops where Description keeps 12 cells, and a column at 4', () => {
  // 60 across: Commit's divider at 51, Author's at 36, Date's at 18.
  expect(dividers(WIDTHS, true, 60).map(d => d.x)).toEqual([51, 36, 18])
  expect(dividers(dragTo(WIDTHS, true, 60, 'date', 0), true, 60)[2]!.x).toBe(12)
  expect(dragTo(WIDTHS, true, 60, 'commit', 59).commit).toBe(4)
})

test('header: search fills the first row with the refresh icon at its right end, the counts below', async ($, on) => {
  replay(on, browse)
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The desktop draws the field's submit as a button, so that button is the refresh icon, and no other.
  expect((await ui.find({ key: 'filter' }) as { props?: { submitLabel?: string } } | undefined)?.props?.submitLabel).toBe('↻')
  expect(await ui.find({ key: 'refresh' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Rows 1–\d+ of \d+ · on main/ })).toBeDefined()
  // The terminal shows its submit only as a hint while typing: there the icon is a Button.
  await ui.unmount()
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ key: 'refresh', text: '↻' })).toBeDefined()
  expect((await term.find({ key: 'filter' }) as { props?: { submitLabel?: string } } | undefined)?.props?.submitLabel).toBe('')
})

test('refresh (desktop): the search field’s ↻ refreshes, keeps the search, and shows … while it runs', async ($, on) => {
  const clock = mock.clock(on)
  replay(on, browse)
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'filter', text: 'divide', kind: 'change' })
  const pressed = ui.input({ key: 'filter', text: 'divide' }) // the ↻ button (or Enter)
  await clock.advance(10)
  expect((await ui.find({ key: 'filter' }) as { props?: { submitLabel?: string } } | undefined)?.props?.submitLabel).toBe('…')
  await clock.advance(400)
  await pressed
  expect(await ui.find({ type: 'Text', text: /^ · ✓ Up to date · / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^1–1 of 1 matching “divide”/ })).toBeDefined()
})

test('scroll asks reuse the drawing, and a change after them still shows', async ($, on) => {
  replay(on, browse)
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const main = '5aa06563723be6ea146d1f64abf83299b83b2c33'
  const scroll = async () => {
    for (let i = 0; i < 5; i++) await ui.redraw({ ...PANE.props, scroll: { offset: i, bodyRows: 40 } })
  }
  await scroll()
  await ui.press({ key: `c:${main}` })
  expect(await findAction(ui, main, `commit:tag`)).toBeDefined()
  await scroll()
  await ui.input({ key: 'filter', text: 'divide', kind: 'change' })
  await scroll()
  expect(await ui.find({ key: `c:${main}` })).toBeUndefined()
  await ui.press({ key: 'filter:clear' })
  await scroll()
  expect(await findAction(ui, main, `commit:tag`)).toBeDefined()
  // A narrower pane is a different drawing.
  await ui.redraw({ ...PANE.props, bodyColumns: 60 })
  expect(await ui.find({ key: 'head:date', in: 'columns' })).toBeUndefined()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`branches (${surface}): the filter narrows the graph to one branch's history, search looks within it`, async ($, on) => {
    const log = replay(on, browse)
    await open($)
    const ui = await $.ui.mount({ ...PANE, surface })
    const tip = 'c:444574dd25ec9727995006e11ab5206a5ada55b9'
    const bulk = 'c:6c0d8bd15f047f460b77a586511755afb04fa794'
    const main = 'c:5aa06563723be6ea146d1f64abf83299b83b2c33'
    // Every branch is offered, local and remote, after All branches.
    const sel = (await ui.find({ key: 'branch-filter' })) as { props?: { value?: string; options?: { value: string; label: string }[] } } | undefined
    expect(sel?.props?.value).toBe('*')
    expect(sel?.props?.options?.map(o => o.label)).toContain('origin/feature/old-api')
    expect(sel?.props?.options?.[0]).toEqual({ value: '*', label: 'All branches' })
    await ui.select({ key: 'branch-filter', value: 'refs/heads/feature/search' })
    expect(await ui.find({ key: tip })).toBeDefined()
    expect(await ui.find({ key: bulk })).toBeUndefined()
    expect(await ui.find({ key: main })).toBeUndefined()
    // HEAD (main) is not in this history, so no uncommitted row.
    expect(await ui.find({ text: /^Uncommitted Changes/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /history of feature\/search/ })).toBeDefined()
    // Search looks within the branch: "helper" finds its helpers, not main's divide helper.
    await ui.input({ key: 'filter', text: 'helper', kind: 'change' })
    expect(await ui.find({ text: /^Add multiply helper$/ })).toBeDefined()
    expect(await ui.find({ text: /^Add divide helper$/ })).toBeUndefined()
    await ui.press({ key: 'filter:clear' })
    // main's own history keeps the uncommitted row (HEAD is in it).
    await ui.select({ key: 'branch-filter', value: 'refs/heads/main' })
    expect(await ui.find({ key: main })).toBeDefined()
    expect(await ui.find({ text: /^Uncommitted Changes/ })).toBeDefined()
    await ui.select({ key: 'branch-filter', value: '*' })
    expect(await ui.find({ key: bulk })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /history of/ })).toBeUndefined()
    expect(log.missing).toEqual([])
  })
}

test('branches: when the chosen branch cannot be read (deleted meanwhile) the graph goes back to every branch', async ($, on) => {
  // fix/typo's narrowed history was not recorded, so git "fails" for it as for a deleted branch.
  replay(on, browse)
  await open($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.select({ key: 'branch-filter', value: 'refs/heads/fix/typo' })
  expect(((await ui.find({ key: 'branch-filter' })) as { props?: { value?: string } } | undefined)?.props?.value).toBe('*')
  expect(await ui.find({ key: 'c:6c0d8bd15f047f460b77a586511755afb04fa794' })).toBeDefined()
})

test('badges: rounded tinted pills on desktop, the checked-out branch solid; solid text on the terminal', async ($, on) => {
  replay(on, browse)
  await open($)
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = async (label: string) => String(((await badge(desk, label)) as { props?: { source?: string } })?.props?.source)
  const fill = (src: string, tag: string) => src.match(new RegExp(`<${tag}[^>]* fill="([^"]+)"`))?.[1]
  const head = await svg('main ⇅')
  expect(head).toMatch(/<rect [^>]*rx="9"/) // rounded
  expect(head).toContain('font-weight="600"')
  expect(fill(head, 'rect')).toMatch(/^#[0-9a-f]{6}$/) // solid
  const branch = await svg('feature/search ⇅')
  expect(fill(branch, 'rect')).toMatch(/^#[0-9a-f]{6}33$/) // a tint
  expect(fill(branch, 'text')).toBe(fill(branch, 'rect')!.slice(0, 7)) // the name in the lane's colour
  expect(branch).toContain('>feature/search ⇅</text>')
  expect(fill(badgeSvg('tag', 'v1.0', '#d97757').source, 'text')).toBe('#c9a14a') // tags ochre, whatever the lane
  await desk.unmount()
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  type P = { props?: { backgroundColor?: string } } | undefined
  expect(((await badge(term, 'feature/search ⇅')) as P)?.props?.backgroundColor).toMatch(/^#[0-9a-f]{6}$/)
  expect(badgeStyle('tag', '#d97757', false).backgroundColor).toBe('#a8803a')
})

test('details: a header of subject, one meta line and the dropdowns on the right; files below with counts by the path', async ($, on) => {
  const main = '5aa06563723be6ea146d1f64abf83299b83b2c33'
  const { ui } = await mount($, on, browse as never)
  await ui.press({ key: `c:${main}` })
  const all = dump(await ui.drawn())
  const t = all.slice(all.indexOf('\nAdd licence section\n')) // the panel, from its subject on
  const lines = t.split('\n').filter(Boolean)
  expect(lines[0]).toBe('Add licence section')
  // One quiet line: who, when, which commit and where it came from.
  expect(lines[1]).toMatch(/^Alex Morgan +< .+ > · +\d{1,2} \w{3} \d{4}, \d\d:\d\d +· +5aa0656 +← +dfe9070 /)
  // The dropdowns sit in the same header row, after the subject block.
  expect(lines[1]).toContain(`{g:${main}:Commit 5aa0656}`)
  expect(t.replace(/\{[^}]*\}/g, '')).not.toContain(main) // the full hash only via Copy hash
  // A single file needs no total; its row reads letter, path, counts.
  expect(t).toMatch(/\n1 +file +changed\n/)
  expect(t).toMatch(/\nM +\[README\.md\]\{f:README\.md\} +\+ ?1 +− ?0\n/)
  expect(shortDate('Wed, 11 Nov 2026 09:10:00 +0000')).toBe('11 Nov 2026, 09:10')
  expect(shortDate('not a date')).toBe('not a date')
})

test('rows: one blank Button spans the whole row on desktop; text cells open it on the terminal', async ($, on) => {
  const main = '5aa06563723be6ea146d1f64abf83299b83b2c33'
  const { ui } = await mount($, on, browse as never)
  await goTo(ui, async () => !!(await ui.find({ key: `c:${main}:row` })))
  expect(await ui.find({ key: `c:${main}:author` })).toBeUndefined()
  await ui.press({ key: `c:${main}:row` })
  expect(await findAction(ui, main, 'commit:copy-hash')).toBeDefined()
  await ui.press({ key: `c:${main}:row` })
  expect(await findAction(ui, main, 'commit:copy-hash')).toBeUndefined()
  await ui.unmount()
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await goTo(term, async () => !!(await term.find({ key: `c:${main}:author` })))
  expect(await term.find({ key: `c:${main}:row` })).toBeUndefined()
  for (const part of ['author', 'hash']) {
    await term.press({ key: `c:${main}:${part}` })
    expect(await findAction(term, main, 'commit:copy-hash')).toBeDefined()
    await term.press({ key: `c:${main}:${part}` })
    expect(await findAction(term, main, 'commit:copy-hash')).toBeUndefined()
  }
})

test('graph spacing: compact, normal and wide set the room between lanes on desktop; the terminal has no control', async ($, on) => {
  const { ui } = await mount($, on, browse as never)
  const width = async () => {
    const svgs = (await ui.findAll({ type: 'Svg' })) as { props?: { alt?: string; source?: string } }[]
    const row = svgs.find(s => s.props?.alt?.startsWith('graph lane'))!
    return Number(row.props!.source!.match(/width="(\d+)"/)![1])
  }
  const normal = await width()
  await ui.select({ key: 'graph-spacing', value: 'wide' })
  const wide = await width()
  await ui.select({ key: 'graph-spacing', value: 'compact' })
  const compact = await width()
  expect(compact).toBeLessThan(normal)
  expect(wide).toBeGreaterThan(normal)
  // Every lane moves by the same step, so the lane count is the same at each width.
  expect((wide - 20) / 26).toBe((normal - 20) / 16)
  expect((compact - 20) / 10).toBe((normal - 20) / 16)
  await ui.unmount()
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ key: 'graph-spacing' })).toBeUndefined()
})

test('/gitview opens the Gitview pane', async ($, on) => {
  replay(on, browse as never)
  const out = (await open($)) as { text?: string }
  expect(out?.text).toBe('Gitview opened.')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(PANE).toMatchObject({ plugin: 'gitview', requestId: 'gitview' })
  expect(await ui.find({ type: 'Text', text: /^Rows / })).toBeDefined()
})

test('badges: a pill sits in a box of its own width, with no cell minimum padding a short tag', async ($, on) => {
  const { ui } = await mount($, on, browse as never)
  type N = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
  const holders: N[] = []
  const walkTree = (n: unknown) => {
    if (!n || typeof n !== 'object') return
    const node = n as N
    const kids = (node.children ?? (node.props?.children as unknown[] | undefined) ?? []) as unknown[]
    const list = Array.isArray(kids) ? kids : [kids]
    if (node.type === 'Box' && list.some(k => (k as N)?.type === 'Svg' && String((k as N).props?.alt ?? '').match(/^(head|branch|remote|tag|stash) /))) holders.push(node)
    list.forEach(walkTree)
  }
  walkTree(await ui.drawn())
  expect(holders.length).toBeGreaterThan(0)
  for (const h of holders) expect(h.props?.minWidth).toBeUndefined()
})
