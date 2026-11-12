import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { ActionResult, Commit, Details, FileChange, FileDiff, GraphData, Pending, RefreshState, View, Widths } from '../types'
import { STAGE_LISTED, describe, groupsFor, visible } from './actions'
import { DESC_MIN, MIN } from './columns'
import type { Action } from './actions'
import { emptyDetails, fingerprint, loadDetails, loadDiff, loadGraph } from './git'
import type { Run } from './git'
import { ROW_PX, SPACING, badgeStyle, badgeSvg, badges, graphWidth, isHeadCommit, laneColor, layout, rowSvg, WORKING } from './graph'
import type { Spacing } from './graph'

const PANE = 'gitview'
const TITLE = 'Gitview'
const POLL_MS = 10_000
const PAGE = 200
// The desktop app drops a pane drawing much past ~100k characters (53 rows
// drew, 153 did not), so rows are drawn in windows that stay under this.
const BUDGET = 90_000
const HOVER = '#8987811f' // the app's warm grey, faint: a row under the pointer
const ROW_FILL = '\u2003'.repeat(120) // em spaces: wider than any pane, clipped to the row
const NONE = '-' // a group dropdown's first entry: its title, no action
// Files drawn in an opened commit: every one would push a big commit's drawing past what the app shows.
const MAX_FILES = 100

const data = atom(
  { plugin: 'gitview', key: 'data' } as const,
  { status: 'loading', message: '', commits: [], hasMore: false, remotes: [], branch: null, headHash: '', localBranches: [] },
  { shape: 'data-3' },
)
const view = atom({ plugin: 'gitview', key: 'view' } as const, { limit: PAGE, offset: 0, selected: null, file: null }, {
  shape: 'view-2',
})
const details = atom({ plugin: 'gitview', key: 'details' } as const, null, { shape: 'details-1' })
const diff = atom({ plugin: 'gitview', key: 'diff' } as const, null, { shape: 'diff-1' })
const pending = atom({ plugin: 'gitview', key: 'pending' } as const, null, { shape: 'pending-1' })
const result = atom({ plugin: 'gitview', key: 'result' } as const, null, { shape: 'result-1' })
const refreshing = atom({ plugin: 'gitview', key: 'refreshing' } as const, null as RefreshState | null, { shape: 'refreshing-1' })
export const WIDTHS: Widths = { date: 17, author: 14, commit: 8 }
const widths = atom({ plugin: 'gitview', key: 'widths' } as const, WIDTHS, { shape: 'widths-1' })
const only = atom({ plugin: 'gitview', key: 'only' } as const, null as string | null, { shape: 'only-1' })
const filter = atom({ plugin: 'gitview', key: 'filter' } as const, '', { shape: 'filter-1' })
const spacing = atom({ plugin: 'gitview', key: 'spacing' } as const, 'normal' as Spacing, { shape: 'spacing-1' })

// Mirrors of what the handlers need, so they never wait on a read.
let current: View = { limit: PAGE, offset: 0, selected: null, file: null }
let commits: Commit[] = []
let onlyRef: string | null = null // the branch the history is narrowed to, a full ref name
let adopted = false // whether a draw has handed the mirrors $.state's values yet
let last = '' // the last git output written, so an unchanged poll does not redraw
let lastRefs = '' // the same without the working tree's status
let shownStatus: GraphData['status'] = 'loading' // what the last read found: a repository or not
let statusError: string | undefined // git status failed on the last read
let stoppedOp: GraphData['operation'] = null // a merge, rebase, cherry-pick or revert waiting on conflicts

// A row matches when every word of the search is in its subject, author, hash or refs (any case).
export const matches = (c: Commit, q: string) => {
  const hay = `${c.subject} ${c.author} ${c.hash} ${c.refs.join(' ')}`.toLowerCase()
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w))
}

// A value's JSON, once per value: $.state hands back the same object while it is unchanged, so a
// scroll tick does not serialize every commit (and a 90 KB diff) again just to find its drawing.
const keyCache = new WeakMap<object, string>()
const keyOf = (v: unknown): string => {
  if (!v || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined'
  let k = keyCache.get(v)
  if (k === undefined) keyCache.set(v, (k = JSON.stringify(v)))
  return k
}

// Every scroll tick asks for the pane again, and building it (each row drawn and measured)
// made scrolling lag. The last drawing is kept with the values it was drawn from, and
// handed back while they read the same: comparing them costs far less than drawing.
let kept: { key: string; tree: unknown } | null = null

const clip = (raw: string, n: number) => {
  const s = visible(raw)
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
// A Select takes at most 64 options, and the engine refuses the whole pane past that (a repository
// with hundreds of branches drew nothing). The branches come newest first; the one narrowed to stays.
const MAX_OPTIONS = 64
export const branchOptions = (branches: string[], narrowed: string | null) => {
  const shown = branches.slice(0, MAX_OPTIONS - 2)
  if (narrowed && !shown.includes(narrowed)) shown.push(narrowed)
  return [
    { value: '*', label: branches.length > shown.length ? `All branches (${branches.length})` : 'All branches' },
    ...shown.map(r => ({ value: r, label: visible(r.replace(/^refs\/(heads|remotes)\//, '')) })),
  ]
}

// git's long answers (a stash apply prints the whole status) cut to their first lines.
export const lines = (s: string, n: number) => {
  const all = s.split('\n')
  return all.length > n ? `${all.slice(0, n).join('\n')}\n…` : s
}

// Answers a check just read (status, HEAD, …), handed to the load it starts instead of running them again.
let primed: Map<string, ReturnType<Run>> | null = null

const runner =
  ($: EngineInterface): Run =>
  argv => {
    const key = JSON.stringify(argv)
    const hit = primed?.get(key)
    if (hit) {
      primed!.delete(key)
      return hit
    }
    // GIT_OPTIONAL_LOCKS=0: a background status must not take index.lock, or a git command
    // Claude or the person runs at that moment fails with "index.lock exists".
    // A read that times out or cannot start is a failed read, not a missing answer.
    return runGit($, argv, { timeoutMs: 20_000, env: { GIT_OPTIONAL_LOCKS: '0' } }).catch(err => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  }

// On Windows a bare `git` is looked for in the child's working folder before PATH, so a cloned
// repository holding a git.exe would run it. There git starts in the system folder and -C points
// it at the repository; argv[0] stays `git`.
let place: { cwd?: string; pre: string[] } = { pre: [] }
async function placeGit($: EngineInterface, repo: string) {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  place = isWindows ? { cwd: (await $.env.get('SystemRoot')) ?? 'C:\\Windows', pre: ['-C', repo] } : { pre: [] }
}
const runGit = ($: EngineInterface, argv: string[], init: { timeoutMs: number; env: Record<string, string>; stdin?: string }) =>
  $.process.run([argv[0]!, ...place.pre, ...argv.slice(1)], place.cwd ? { ...init, cwd: place.cwd } : init)

async function setView($: EngineInterface, next: View) {
  current = next
  await update($, view, () => next)
}

// One read of the repository at a time: the poll, a Bash call and a Run can all ask at once.
// Asks that come while one runs share a single read after it, which they all wait for.
let reading: Promise<boolean> | null = null
let queued: Promise<boolean> | null = null
let queuedForce = false
function refresh($: EngineInterface, force = false): Promise<boolean> {
  if (!reading) {
    // load writes state too; a failed write must not reject every caller (and the poll) with it.
    reading = load($, force)
      .catch(() => false)
      .finally(() => (reading = null))
    return reading
  }
  queuedForce ||= force
  const after = () => {
    const f = queuedForce
    queued = null
    queuedForce = false
    return refresh($, f)
  }
  queued ??= reading.then(after, after)
  return queued
}

// Background reads skip a closed pane; /gitview reads again as it opens.
const isPaneUp = async ($: EngineInterface) => (await $.ui.panes()).some(p => p.id === PANE)

// The poll and Bash calls read a cheap fingerprint first (refs, stashes, status, HEAD) and the full
// history (log --topo-order, slow on a big repository) only when it moved. One check at a time;
// asks during one (a Bash call right after the poll began) fold into one more check after it.
let lastPrint = ''
let loads = 0 // loads run, so a check knows whether another one ran beside its own
let checking = false
let recheck = false
async function check($: EngineInterface) {
  if (checking) {
    recheck = true
    return
  }
  checking = true
  try {
    do {
      recheck = false
      if (!(await isPaneUp($))) return
      const read = new Map<string, ReturnType<Run>>()
      const run = runner($)
      const fp = await fingerprint(argv => {
        const r = run(argv)
        read.set(JSON.stringify(argv), r)
        return r
      })
      if (fp === lastPrint) continue
      const before = loads
      primed = read
      try {
        await refresh($)
      } finally {
        primed = null
      }
      // Only when the load was this check's own: one beside it may show a newer state than fp.
      if (loads === before + 1) lastPrint = fp
    } while (recheck)
  } finally {
    checking = false
  }
}

async function load($: EngineInterface, force: boolean) {
  lastPrint = '' // read for another reason: the next check reads again rather than trust an older print
  loads++
  let next: GraphData
  let raw: string
  let refs: string
  try {
    let g = await loadGraph(runner($), current.limit, onlyRef)
    // The branch it was narrowed to is gone (deleted, renamed): back to every branch.
    if (g.status === 'error' && onlyRef && !g.branches?.includes(onlyRef)) {
      onlyRef = null
      await update($, only, () => null)
      g = await loadGraph(runner($), current.limit, null)
    }
    raw = g.raw
    refs = g.refs
    statusError = g.statusError
    const { raw: _raw, refs: _refs, statusError: _statusError, ...rest } = g
    next = rest
  } catch (err) {
    raw = refs = String(err)
    statusError = String(err)
    next = {
      status: 'error',
      message: `Could not run git: ${String(err)}`,
      commits: [],
      hasMore: false,
      remotes: [],
      branch: null,
      headHash: '',
      localBranches: [],
    }
  }
  const changed = raw !== last
  if (!force && !changed) return changed
  last = raw
  lastRefs = refs
  shownStatus = next.status
  stoppedOp = next.operation ?? null
  commits = next.commits
  await update($, data, () => next)
  // The open commit's file list can change too (uncommitted changes above all).
  if (current.selected && commits.some(c => c.hash === current.selected)) void openDetails($, current.selected)
  return changed
}

const pad = (n: number) => String(n).padStart(2, '0')
let isRefreshing = false

// The Refresh button: git answers in a few ms, so "Refreshing…" stays up a moment to be seen,
// then the header says whether anything changed and when.
async function pressRefresh($: EngineInterface) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    await update($, refreshing, () => ({ status: 'running' }))
    const [changed] = await Promise.all([refresh($, true), $.clock.sleep(400)])
    const t = new Date(await $.clock.now())
    const at = `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`
    await update($, refreshing, (): RefreshState => ({ status: 'done', text: `${changed ? 'Updated' : 'Up to date'} · ${at}` }))
  } finally {
    isRefreshing = false
  }
}

// Loads of the open commit's details can overlap (a refresh, a click): only the newest one is written.
let detailsSeq = 0

async function openDetails($: EngineInterface, hash: string) {
  const c = commits.find(one => one.hash === hash)
  if (!c) return
  const seq = ++detailsSeq
  const loaded = await loadDetails(runner($), c).catch(
    (err): Details => ({ ...emptyDetails(hash), status: 'error', message: String(err) }),
  )
  if (current.selected !== hash || seq !== detailsSeq) return
  await update($, details, () => loaded)
}



let pendingNow: Pending | null = null

async function setPending($: EngineInterface, next: Pending | null) {
  pendingNow = next
  await update($, pending, () => next)
}

async function startAction($: EngineInterface, hash: string, action: Action, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface']) {
  if (action.copy !== undefined) {
    await $.ui.copy({ text: action.copy, surface })
    $.ui.toast(`Copied ${clip(action.copy, 40)}`)
    return
  }
  await setPending($, {
    id: action.id,
    hash,
    value: action.input?.value ?? '',
    choice: action.choice?.options[0]?.value ?? '',
    status: 'idle',
    message: '',
  })
}

async function runAction($: EngineInterface, action: Action) {
  const p = pendingNow
  if (!p || p.id !== action.id || !action.run || p.status === 'running') return
  const value = p.value.trim()
  // The confirm step hides Run then, but Enter in a name field calls this directly.
  if (stoppedOp && !action.id.startsWith('working:')) {
    await setPending($, { ...p, status: 'error', message: `The ${stoppedOp} stopped. Continue or abort it from Uncommitted Changes first.` })
    return
  }
  if (action.input && !action.input.isOptional && !value) {
    await setPending($, { ...p, status: 'error', message: `${action.input.label} is required.` })
    return
  }
  // Every required input is a branch or tag name, which git would read as an option if it began with -.
  if (action.input && !action.input.isOptional && value.startsWith('-')) {
    await setPending($, { ...p, status: 'error', message: `${action.input.label} can't start with -.` })
    return
  }
  await setPending($, { ...p, status: 'running', message: '' })
  // The repository may have moved since this was drawn (Claude, or a terminal): a stash@{n} names
  // another stash, "Reset main" would reset another branch. Read again, and stop if it changed.
  // Changes in the working tree count for the uncommitted row's actions and every dangerous one
  // (a hard reset would throw away edits made after this was shown).
  const withStatus = p.hash === WORKING || !!action.isDanger
  const seen = withStatus ? last : lastRefs
  await refresh($)
  if ((withStatus ? last : lastRefs) !== seen) {
    await setPending($, { ...p, status: 'error', message: 'The repository changed since this was shown. Check the action above and run it again.' })
    return
  }
  // Without a working tree status the check above compares nothing, and a hard reset or discard
  // could throw away edits nobody was shown.
  if (withStatus && statusError) {
    await setPending($, { ...p, status: 'error', message: `git status failed, so the working tree is unknown: ${lines(statusError, 3)}` })
    return
  }
  const out: string[] = []
  let prev = ''
  for (const argv of action.run(value, p.choice)) {
    // The engine's limit: a rebase, checkout or push on a big repository can take minutes, and
    // git killed midway leaves index.lock or a half-done operation behind.
    const r = await runGit($, ['git', ...argv], {
      timeoutMs: 600_000,
      env: { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
      ...(argv === STAGE_LISTED ? { stdin: prev } : {}),
    }).catch(err => ({
      exitCode: -1,
      stdout: '',
      stderr: `git ${argv[0]} did not finish (${String(err)}). Run git status in a terminal before going on: a stopped git can leave .git/index.lock or a half-done operation behind.`,
    }))
    prev = r.stdout
    out.push(r.stdout.trim(), r.stderr.trim())
    if (r.exitCode !== 0) {
      const text = lines(r.stderr.trim() || r.stdout.trim() || `git ${argv[0]} failed`, 8)
      await setPending($, { ...p, status: 'error', message: text })
      // A stash apply or pop leaves conflicts without any stopped-operation marker: say where they are.
      const conflict = /^CONFLICT /m.test(`${r.stdout}\n${r.stderr}`)
      const name = action.label.replace('…', '')
      await update($, result, (): ActionResult => ({
        isOk: false,
        text: conflict ? `${name} stopped on a conflict: resolve it in Uncommitted Changes` : `${name} failed`,
      }))
      await refresh($, true)
      return
    }
  }
  await setPending($, null)
  const summary = out.filter(Boolean).join('\n').split('\n').slice(-1)[0] ?? ''
  await update($, result, (): ActionResult => ({ isOk: true, text: `${action.label.replace('…', '')}: done${summary ? ` (${clip(summary, 80)})` : ''}` }))
  $.ui.toast(`${action.label.replace('…', '')}: done`)
  await refresh($, true)
}

async function selectCommit($: EngineInterface, hash: string) {
  await setPending($, null)
  if (current.selected === hash) {
    await setView($, { ...current, selected: null, file: null })
    return
  }
  await setView($, { ...current, selected: hash, file: null, openedAt: current.offset })
  await update($, details, () => emptyDetails(hash))
  await update($, diff, () => null)
  await openDetails($, hash)
}

async function selectFile($: EngineInterface, file: FileChange) {
  const hash = current.selected
  const c = commits.find(one => one.hash === hash)
  if (!hash || !c) return
  if (current.file === file.path) {
    await setView($, { ...current, file: null })
    return
  }
  await setView($, { ...current, file: file.path })
  await update($, diff, () => ({ hash, path: file.path, status: 'loading', text: '', isTruncated: false }))
  const loaded = await loadDiff(runner($), c, file).catch(
    (err): FileDiff => ({ hash, path: file.path, status: 'error', text: String(err), isTruncated: false }),
  )
  if (current.selected === hash && current.file === file.path) await update($, diff, () => loaded)
}

// Where each Show older came from, so Show newer goes back to exactly that window: measuring the
// rows above again can come out a little different (a row's drawing is not the same size twice).
let back: number[] = []

// `end` and `shown` count the rows the search lets through; the draw clamps the offset to them.
async function showOlder($: EngineInterface, start: number, end: number, shown: number, hasMore: boolean) {
  back.push(start)
  if (end >= shown && hasMore) {
    current = { ...current, limit: current.limit + PAGE }
    await refresh($, true)
  }
  await setView($, { ...current, openedAt: undefined, offset: end })
}

// Narrows the graph to one branch's history (null: every branch), from the top.
async function setBranch($: EngineInterface, ref: string | null) {
  onlyRef = ref
  back = []
  await update($, only, () => ref)
  await setView($, { ...current, openedAt: undefined, offset: 0 })
  await refresh($, true)
}

async function setFilter($: EngineInterface, q: string) {
  back = []
  await update($, filter, () => q)
  await setView($, { ...current, openedAt: undefined, offset: 0 })
}

async function showNewer($: EngineInterface, start: number) {
  if (back.at(-1) === start) back.pop()
  await setView($, { ...current, openedAt: undefined, offset: start })
}

// The drawing's size as the engine will carry it; elements are plain data. A press handle is
// left out: its number grows as the session draws, so the same row measured a little bigger
// each time, and the windows shifted (Show newer came back a row short).
function sizeOf(tree: unknown): number {
  try {
    return JSON.stringify(tree, (k, v) => (k === 'handle' ? undefined : v)).length
  } catch {
    return 2_000
  }
}

// Added and removed in the palette's mineral and soft red, as the status letters are.
const ADD = '#629987'
const DEL = '#d0605e'
const STATUS: Record<string, { label: string; color: string }> = {
  A: { label: 'A', color: ADD },
  M: { label: 'M', color: '#6a9bcc' },
  D: { label: 'D', color: DEL },
  R: { label: 'R', color: '#827dbd' },
  C: { label: 'C', color: '#827dbd' },
  T: { label: 'T', color: '#c9a14a' },
  U: { label: 'U', color: DEL },
  '?': { label: 'U', color: ADD },
}

// git's %aD (`Wed, 11 Nov 2026 09:10:00 +0000`) as the pane says it: `11 Nov 2026, 09:10`.
export const shortDate = (raw: string) => raw.match(/(\d{1,2} \w{3} \d{4}) (\d\d:\d\d)/)?.slice(1).join(', ') ?? raw

// VS Code has graph extensions of its own, so Gitview stays out of it.
const NOT_IN_VSCODE = 'Gitview runs in the terminal and the Claude desktop app. In VS Code, use a git graph extension.'
// The surface the session started on; session.start runs again on a reload, so this is set again too.
let startSurface: string | null = null
let poll: { cancel(): void } | null = null

// /gitview opens the pane.
async function openPane($: EngineInterface) {
  if (startSurface === 'vscode') return { text: NOT_IN_VSCODE }
  await $.ui.open({ id: PANE, title: TITLE })
  await refresh($, true)
  return { text: 'Gitview opened.' }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'gitview', description: 'Show the repository’s branch and commit graph in a pane' })
    startSurface = e.surface
    await placeGit($, e.cwd)
    // Scripts (claude -p) get /gitview but no pane or reads of their own.
    if (e.surface === 'vscode' || !e.isInteractive) return next(e)
    // The pane opens on its own only in a repository; elsewhere /gitview still opens it.
    void refresh($, true)
      .then(() => (shownStatus === 'not-repo' ? undefined : $.ui.open({ id: PANE, title: TITLE })))
      .catch(() => {})
    poll?.cancel()
    poll = $.clock.every(POLL_MS, () => void check($).catch(() => {}))
    return next(e)
  })

  on('command.run', { command: 'gitview' }, openPane)

  // Commits, checkouts and merges mostly happen through Bash: redraw right after one.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (startSurface !== 'vscode') check($).catch(() => {})
    return ran
  })

  // The column heads post widths while a divider is dragged; anything else in the message is ignored.
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'columns') return next(e)
    const w = (e.data as { widths?: Partial<Widths> } | null)?.widths
    const size = (n: unknown, d: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(MIN, Math.min(60, Math.round(n))) : d)
    if (w) await update($, widths, old => ({ date: size(w.date, old.date), author: size(w.author, old.author), commit: size(w.commit, old.commit) }))
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // A pane opened elsewhere in a session VS Code also shows: VS Code gets a note, not the graph.
    if (e.surface === 'vscode') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>{NOT_IN_VSCODE}</Text>
    }
    try {
      return await drawPane($, e)
    } catch (err) {
      const { Text } = $.ui.resolve(e)
      return <Text color={DEL}>Gitview could not draw: {String(err)}</Text>
    }
  })
}

async function drawPane($: EngineInterface, e: RenderInput) {
  const els = $.ui.resolve(e)
  const { Box, Text, Button, Code } = els
  // The mobile app draws no fields yet: choices become buttons there, and names cannot be typed.
  // (its table may still hand them out, drawn as nothing, so the surface decides).
  const fields = e.surface !== 'mobile'
  const Input = fields && 'Input' in els ? els.Input : null
  const Select = fields && 'Select' in els ? els.Select : null
  const d = await read($, data)
  const v = await read($, view)
  const det = await read($, details)
  const fd = await read($, diff)
  const pend = await read($, pending)
  const res = await read($, result)
  const rf = await read($, refreshing)
  const narrowed = await read($, only)
  const sp = await read($, spacing)
  const gap = SPACING[sp] ?? SPACING.normal
  const typed = await read($, filter) // as typed: trimming it would eat the space before a second word
  const q = typed.trim()
  // After a reload the module's mirrors start over while $.state keeps the values: take them once.
  // Never again: a live draw can read a value from before a handler's latest write, and copying it
  // back threw away a commit's details as they arrived (the row stayed on Loading…).
  if (!adopted) {
    adopted = true
    pendingNow = pend
    commits = d.commits
    current = v
    onlyRef = narrowed
  }
  const width = (e.props as { bodyColumns?: number }).bodyColumns ?? 120
  const w = await read($, widths)
  // A narrow pane drops Date so Description keeps room to read; Author always stays.
  const showDate = width >= 70
  // Unchanged values (a scroll tick's ask): the drawing they made last time.
  const key = [e.surface, width, typed, narrowed, sp, d, v, det, fd, pend, res, rf, w].map(keyOf).join('\0')
  if (kept?.key === key) return kept.tree as JSX.Element
  const keep = (tree: JSX.Element) => ((kept = { key, tree }), tree)

  const refreshIcon = rf?.status === 'running' ? '…' : '↻'
  const submitRefreshes = !!Input && (e.surface === 'desktop' || e.surface === 'vscode')
  const header = (count: string) => (
    <Box flexDirection="column" gap={1}>
      {/* Search first, filtering as it is typed; Refresh an icon at the row's right end. The desktop
          draws an Input's submit as a button whatever its label (an empty one stayed), so there that
          button is the refresh icon: Enter has nothing else to do, the list already follows each key. */}
      <Box flexDirection="row" alignItems="center" gap={1}>
        {/* The branch first: it narrows what the search then looks through. On the desktop the
            search field's own button (↻) stays at the right of the field. */}
        {Select && (d.branches?.length ?? 0) > 0 && (
          <Box flexShrink={0}>
            <Select
              key="branch-filter"
              options={branchOptions(d.branches!, narrowed)}
              value={narrowed ?? '*'}
              onSelect={(value: string) => void setBranch($, value === '*' ? null : value)}
            />
          </Box>
        )}
        {Select && e.surface !== 'terminal' && (
          <Box flexShrink={0}>
            <Select
              key="graph-spacing"
              options={[
                { value: 'compact', label: 'Graph: compact' },
                { value: 'normal', label: 'Graph: normal' },
                { value: 'wide', label: 'Graph: wide' },
              ]}
              value={sp}
              onSelect={(value: string) => void update($, spacing, () => (value in SPACING ? (value as Spacing) : 'normal'))}
            />
          </Box>
        )}
        <Box flexGrow={1} minWidth={0}>
          {Input && (
            <Input
              key="filter"
              placeholder="Search subject, author, hash, branch or tag"
              value={typed}
              submitLabel={submitRefreshes ? refreshIcon : ''}
              onInput={(value: string) => void setFilter($, value)}
              onSubmit={(value: string) => void (submitRefreshes ? pressRefresh($) : setFilter($, value))}
            />
          )}
        </Box>
        {typed && <Button key="filter:clear" label="Clear" onPress={() => void setFilter($, '')} />}
        {!submitRefreshes && (
        <Button
          key="refresh"
          label={refreshIcon}
          hotkey="r"
          dimColor={rf?.status === 'running'}
          onPress={() => void pressRefresh($)}
        />
        )}
      </Box>
      <Text dimColor wrap="truncate">
        {[count, d.branch && `on ${d.branch}`, narrowed && `history of ${narrowed.replace(/^refs\/(heads|remotes)\//, '')}`].filter(Boolean).join(' · ')}
        {rf?.status === 'done' && <Text color={ADD}>{` · ✓ ${rf.text}`}</Text>}
      </Text>
      {/* Notices get full-width lines of their own: squeezed into the row above they wrapped word by word. */}
      {d.operation && (
        <Text color="#f5a524">
          The {d.operation} stopped on a conflict. Open Uncommitted Changes to continue or abort it.
        </Text>
      )}
      {res && (
        <Text color={res.isOk ? ADD : DEL} wrap="truncate">
          {res.text}
        </Text>
      )}
      {/* No divider element or one-sided border exists, so a dim rule parts the header from the graph. */}
      <Text dimColor wrap="truncate">
        {'─'.repeat(width)}
      </Text>
    </Box>
  )

  if (d.status !== 'ok') {
    const message = d.status === 'empty' ? 'No commits yet.' : d.message
    return keep(
      <Box flexDirection="column" gap={1}>
        {header(d.status === 'loading' ? 'Loading…' : '')}
        {message && <Text dimColor>{message}</Text>}
      </Box>
    )
  }

  const lay = layout(d.commits)
  const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : null

  const graphCell = (r: number) => {
    const c = d.commits[r]!
    if (Svg) {
      return (
        <Svg source={rowSvg(d.commits, lay, r, isHeadCommit(c), gap)} alt={`graph lane ${lay.cols[r]! + 1}`} height={ROW_PX} />
      )
    }
    const mark = c.kind === 'working' ? '◌' : c.kind === 'stash' ? '◎' : c.parents.length > 1 ? '◯' : '●'
    return <Text color={laneColor(lay.cols[r]!)}>{'  '.repeat(lay.cols[r]!) + mark}</Text>
  }

  // Badges sit outside the Button: a desktop button drops a Text's background.
  const description = (c: Commit, r: number) => {
    const lane = laneColor(lay.cols[r]!)
    return (
      <Box flexDirection="row" alignItems="center" gap={1} width="100%" flexShrink={1} minWidth={0} overflow="hidden">
        {/* A badge keeps up to 14 cells (a tag like v1.2.0 whole) and gives way past that before
            the subject does: in a narrow column the subject kept 2 cells and wrapped. */}
        {badges(c, d.remotes, d.localBranches).map(b => {
          if (Svg) {
            const label = `${clip(b.label, 28)}${b.isSynced ? ' ⇅' : ''}`
            const pill = badgeSvg(b.kind, label, lane)
            return (
              <Box flexShrink={0}>
                <Svg source={pill.source} alt={`${b.kind} ${label}`} width={pill.width} height={pill.height} />
              </Box>
            )
          }
          const text = ` ${clip(b.label, 28)}${b.isSynced ? ' ⇅' : ''} `
          return (
            <Box flexShrink={1} minWidth={Math.min(text.length, 14)} overflow="hidden">
              <Text {...badgeStyle(b.kind, lane, e.surface !== 'terminal')} wrap="truncate">
                {text}
              </Text>
            </Box>
          )
        })}
        {/* The terminal's Button wraps its label whatever the Text says: one row keeps the row one line. */}
        <Box flexShrink={1} minWidth={Math.min(12, c.subject.length)} overflow="hidden" height={e.surface === 'terminal' ? 1 : undefined}>
          <Button key={`c:${c.hash}`} plain onPress={() => void selectCommit($, c.hash)}>
            <Text bold={isHeadCommit(c) || undefined} italic={c.kind !== 'commit' || undefined} dimColor={c.kind === 'stash' || undefined} wrap="truncate">
              {visible(c.subject)}
            </Text>
          </Button>
        </Box>
      </Box>
    )
  }

  const fileRow = (f: FileChange) => {
    const s = STATUS[f.status] ?? { label: f.status, color: '#898781' }
    const counts = f.added === null ? (f.status === '?' ? 'untracked' : 'binary') : `+${f.added} −${f.removed}`
    return (
      <Box flexDirection="column">
        {/* Desktop Buttons drop a child Text's colour, so the coloured parts sit outside it.
            Three fixed columns: the status letter, the path, the counts right-aligned. */}
        <Box flexDirection="row" gap={1}>
          <Box width={2} flexShrink={0}>
            <Text color={s.color} mono>
              {s.label}
            </Text>
          </Box>
          {/* Letter, path, then its counts right after it: they stay next to what they count. */}
          <Box flexShrink={1} minWidth={0} marginRight={1}>
            <Button key={`f:${f.path}`} plain onPress={() => void selectFile($, f)}>
              {f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
            </Button>
          </Box>
          <Box flexShrink={0}>
            {/* Untracked files show U too (VS Code's letter), so a conflict says so in words. */}
            {f.status === 'U' ? (
              <Text color={DEL}>conflict</Text>
            ) : f.added === null ? (
              <Text dimColor>{counts}</Text>
            ) : (
              <Text mono>
                <Text color={ADD}>+{f.added}</Text> <Text color={DEL}>−{f.removed}</Text>
              </Text>
            )}
          </Box>
        </Box>
        {v.file === f.path && fd?.path === f.path && (
          <Box flexDirection="column" marginLeft={2}>
            {fd.status === 'loading' && <Text dimColor>Loading diff…</Text>}
            {fd.status === 'error' && <Text color={DEL}>{fd.text}</Text>}
            {fd.status === 'ok' && !fd.text.trim() && <Text dimColor>{f.oldPath ? 'Renamed with no content changes.' : 'No textual changes.'}</Text>}
            {fd.status === 'ok' && fd.text.trim() && <Code source={fd.text} format="diff" path={f.path} />}
            {fd.isTruncated && <Text dimColor>Diff cut short: it is too long to show here.</Text>}
          </Box>
        )}
      </Box>
    )
  }

  const actionsBox = (c: Commit) => {
    const groups = groupsFor(c, {
      branch: d.branch,
      headHash: d.headHash,
      remotes: d.remotes,
      localBranches: d.localBranches,
      operation: d.operation,
    })
    const all = groups.flatMap(g => g.actions)
    const open = pend && pend.hash === c.hash ? all.find(a => a.id === pend.id) : undefined
    // One dropdown per group (the commit, each branch, tag or stash on it) in place of a wall of
    // buttons: its first entry names the group, picking an action opens its confirm step.
    // The panel's header carries the dropdowns; the confirm step (and, without Select, the buttons) sits below.
    const menus = Select ? (
      <Box flexDirection="row" flexWrap="wrap" gap={1} flexShrink={0}>
        {groups.map(g => (
          <Select
            key={`g:${c.hash}:${g.title}`}
            options={[{ value: NONE, label: g.title }, ...g.actions.map(a => ({ value: a.id, label: a.label }))]}
            value={open && g.actions.includes(open) ? open.id : NONE}
            onSelect={(id, ev) => {
              const a = g.actions.find(x => x.id === id)
              if (a) void startAction($, c.hash, a, ev.surface)
              else if (open && g.actions.includes(open)) void setPending($, null)
            }}
          />
        ))}
      </Box>
    ) : null
    const rest =
      !Select || open ? (
        <Box flexDirection="column" gap={1}>
          {!Select &&
            groups.map(g => (
              <Box flexDirection="column">
                <Text dimColor bold>
                  {g.title}
                </Text>
                <Box flexDirection="row" flexWrap="wrap" gap={1}>
                  {g.actions.map(a => (
                    <Button key={`a:${c.hash}:${a.id}`} label={a.label} onPress={press => void startAction($, c.hash, a, press.surface)} />
                  ))}
                </Box>
              </Box>
            ))}
          {open && pend && confirmBox(open, pend)}
        </Box>
      ) : null
    return { menus, rest }
  }

  const confirmBox = (a: Action, p: Pending) => {
    // While a merge, cherry-pick, revert or rebase is stopped, only its own continue/abort can run.
    const stopped = !!d.operation && !a.id.startsWith('working:')
    // A required name shows as a placeholder until typed; an optional one left empty is simply left out.
    const shown = p.value.trim() || (a.input && !a.input.isOptional ? `<${a.input.label.toLowerCase()}>` : '')
    const cmds = a.run ? describe(a.run(shown, p.choice)) : ''
    return (
      <Box flexDirection="column" gap={1} padding={1} borderStyle="round" borderColor={a.isDanger ? DEL : '#898781'}>
        <Text bold>{a.label.replace('…', '')}</Text>
        {a.choice && !Select && (
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {a.choice.options.map(o => (
              <Button
                key={`choice:${a.id}:${o.value}`}
                variant={o.value === p.choice ? 'primary' : undefined}
                label={o.label}
                onPress={() => void setPending($, { ...p, choice: o.value, status: 'idle', message: '' })}
              />
            ))}
          </Box>
        )}
        {a.choice && Select && (
          <Select
            key={`choice:${a.id}`}
            label={a.choice.label}
            options={a.choice.options}
            value={p.choice}
            onSelect={(value: string) => void setPending($, { ...p, choice: value, status: 'idle', message: '' })}
          />
        )}
        {a.input && !Input && !a.input.isOptional && (
          <Text dimColor>{a.input.label} can be typed in the terminal or the desktop app.</Text>
        )}
        {a.input && Input && (
          <Input
            key={`input:${a.id}`}
            label={a.input.label}
            value={p.value}
            autoFocus
            submitLabel={a.label.replace('…', '')}
            onInput={(value: string) => {
              if (pendingNow) pendingNow = { ...pendingNow, value }
            }}
            onSubmit={(value: string) => {
              if (!pendingNow) return
              pendingNow = { ...pendingNow, value }
              void runAction($, a)
            }}
          />
        )}
        <Text dimColor mono>
          {cmds}
        </Text>
        {a.isDanger && <Text color={DEL}>This cannot be undone from here.</Text>}
        {p.status === 'error' && <Text color={DEL}>{p.message}</Text>}
        {stopped && <Text color="#f5a524">The {d.operation} stopped. Resolve the conflicts, then continue or abort it from Uncommitted Changes.</Text>}
        {p.status === 'running' ? (
          <Text dimColor>Running…</Text>
        ) : (
          <Box flexDirection="row" gap={1}>
            {(!a.input || (!Input && a.input.isOptional)) && !stopped && (
              <Button key={`run:${a.id}`} variant="primary" label={a.isDanger ? `Yes, ${a.label.replace('…', '').toLowerCase()}` : 'Run'} onPress={() => void runAction($, a)} />
            )}
            <Button key={`cancel:${a.id}`} role="dismiss" label="Cancel" onPress={() => void setPending($, null)} />
          </Box>
        )}
      </Box>
    )
  }

  const detailsBox = (c: Commit) => {
    const x = det && det.hash === c.hash ? det : null
    const acts = x?.status === 'ok' ? actionsBox(c) : null
    const sum = (k: 'added' | 'removed') => x?.files.reduce((n, f) => n + (f[k] ?? 0), 0) ?? 0
    return (
      <Box flexDirection="column" gap={1} paddingX={2} paddingY={1} marginY={1} borderStyle="round" borderColor={laneColor(lay.cols[d.commits.indexOf(c)]!)}>
        {(!x || x.status === 'loading') && <Text dimColor>Loading…</Text>}
        {x?.status === 'error' && <Text color={DEL}>{x.message}</Text>}
        {x?.status === 'ok' && acts && (
          <Box flexDirection="column" gap={1}>
            {/* Header: what the commit says and who made it, its actions on the right (below, when narrow). */}
            <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="flex-start" columnGap={2} rowGap={1}>
              <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={24}>
                <Text bold>{x.message}</Text>
                {(c.kind === 'commit' || c.kind === 'stash') && (
                  <Text dimColor>
                    {x.author} &lt;{x.email}&gt; · {shortDate(x.date)} · {c.kind === 'stash' ? 'stash ' : ''}
                    <Text mono>{c.hash.slice(0, 7)}</Text>
                    {x.parents.length > 0 && (
                      <Text>
                        {' ← '}
                        <Text mono>{x.parents.map(p => p.slice(0, 7)).join(', ')}</Text>
                      </Text>
                    )}
                  </Text>
                )}
              </Box>
              {acts.menus}
            </Box>
            {acts.rest}
            <Box flexDirection="column">
              <Text dimColor>
                {x.files.length} file{x.files.length === 1 ? '' : 's'} changed
                {x.files.length > 1 && x.files.some(f => f.added !== null) && (
                  <Text mono>
                    {'  '}
                    <Text color={ADD}>+{sum('added')}</Text> <Text color={DEL}>−{sum('removed')}</Text>
                  </Text>
                )}
              </Text>
              {x.files.slice(0, MAX_FILES).map(fileRow)}
              {x.files.length > MAX_FILES && (
                <Text dimColor>
                  {x.files.length - MAX_FILES} more not shown. See them all with{' '}
                  {c.kind === 'working' ? 'git status' : `git show --stat ${c.hash.slice(0, 7)}`}
                </Text>
              )}
            </Box>
          </Box>
        )}
      </Box>
    )
  }

  // Only the terminal and desktop draw a Client (another table may still hand one out, drawn as nothing).
  const Client = (e.surface === 'terminal' || e.surface === 'desktop') && 'Client' in els ? els.Client : null
  const graphHead = Svg ? (
    <Svg source={`<svg xmlns="http://www.w3.org/2000/svg" width="${graphWidth(lay.lanes, gap)}" height="16"/>`} alt="graph column" height={16} />
  ) : (
    <Box width={lay.lanes * 2}>
      <Text> </Text>
    </Box>
  )
  const head = (label: string, cols: number) => (
    <Box width={cols} flexShrink={0}>
      <Text dimColor bold wrap="truncate">
        {label}
      </Text>
    </Box>
  )
  // Where a Client can be drawn its dividers drag to resize the columns; elsewhere the heads are plain.
  const columnHeads = (
    <Box flexDirection="row" gap={1}>
      {graphHead}
      {Client ? (
        <Client key="columns" module="./columns.ts" props={{ widths: w, showDate }} height={1} flexGrow={1} />
      ) : (
        [
          <Box width="100%" flexShrink={1} minWidth={0}>
            <Text dimColor bold>
              Description
            </Text>
          </Box>,
          showDate && head('Date', w.date),
          head('Author', w.author),
          head('Commit', w.commit),
        ]
      )}
    </Box>
  )

  // Every text cell of a row opens it (a Button holds only text, so the graph and badges cannot),
  // and the whole row lights under the pointer so it reads as one target.
  // The terminal opens a row from any of its text cells (a Button holds only text). The desktop lays
  // one blank Button over the whole row instead: a Button takes no size, so a run of em spaces
  // spans it, clipped to the row. Spaces over a terminal row would blank its text, hence cells there.
  const overlay = e.surface === 'desktop'
  // The terminal's Button wraps its label whatever the Text says: one row keeps each cell one line.
  const oneRow = e.surface === 'terminal' ? 1 : undefined
  const cell = (c: Commit, part: string, text: string, extra: Record<string, unknown> = {}) =>
    overlay ? (
      <Text dimColor wrap="truncate" {...extra}>
        {text}
      </Text>
    ) : (
      <Button key={`c:${c.hash}:${part}`} plain onPress={() => void selectCommit($, c.hash)}>
        <Text dimColor wrap="truncate" {...extra}>
          {text}
        </Text>
      </Button>
    )
  const rowOf = (c: Commit, r: number) => (
    <Box flexDirection="column">
      <Box key={`row:${c.hash}`} flexDirection="row" alignItems="center" gap={1} hover={{ backgroundColor: HOVER }}>
        <Box flexShrink={0}>{graphCell(r)}</Box>
        {description(c, r)}
        {showDate && (
          <Box width={w.date} flexShrink={0} overflow="hidden" height={oneRow}>
            {cell(c, 'date', c.date)}
          </Box>
        )}
        <Box width={w.author} flexShrink={0} overflow="hidden" height={oneRow}>
          {cell(c, 'author', c.author)}
        </Box>
        <Box width={w.commit} flexShrink={0} overflow="hidden" height={oneRow}>
          {cell(c, 'hash', c.kind === 'working' ? '*' : c.hash.slice(0, 7), { mono: true })}
        </Box>
        {overlay && (
          <Box position="absolute" top={0} left={0} right={0} bottom={0} overflow="hidden">
            <Button key={`c:${c.hash}:row`} plain onPress={() => void selectCommit($, c.hash)}>
              {ROW_FILL}
            </Button>
          </Box>
        )}
      </Box>
      {v.selected === c.hash && detailsBox(c)}
    </Box>
  )

  // The rows the search lets through, by their place in the graph; windows count these.
  const shown = q ? d.commits.flatMap((c, r) => (matches(c, q) ? [r] : [])) : d.commits.map((_, r) => r)
  // Draw rows from the window's start until the size budget is spent.
  let start = Math.min(v.offset, Math.max(0, shown.length - 1))
  // Each row drawn and measured once per draw: the window below slides over them.
  const memo = new Map<number, { el: ReturnType<typeof rowOf>; size: number }>()
  const at = (i: number) => {
    let m = memo.get(i)
    if (!m) {
      const el = rowOf(d.commits[shown[i]!]!, shown[i]!)
      m = { el, size: sizeOf(el) }
      memo.set(i, m)
    }
    return m
  }
  const fits = (from: number) => {
    let n = 0
    for (let i = from, used = 0; i < shown.length; i++, n++) {
      used += at(i).size
      if (used > BUDGET && n > 0) break
    }
    return n
  }
  let count0 = fits(start)
  // Opening a row grows only that row, so when it no longer fits it is the very next one past
  // the end: the window then moves down, as few rows as it takes, to keep it and its actions drawn.
  // Only until the window pages (Show newer or older), so paging always moves away from an open row.
  const open = v.selected ? shown.findIndex(r => d.commits[r]!.hash === v.selected) : -1
  if (open === start + count0 && v.openedAt === v.offset) while (open >= start + count0 && start < open) count0 = fits(++start)
  const rows = Array.from({ length: count0 }, (_, k) => at(start + k).el)
  const end = start + rows.length
  // Show newer goes back to where Show older came from; with nothing remembered (after a
  // reload) it is the rows just above this one that fit the budget.
  let newer = start
  for (let i = start - 1, size = 0; i >= 0; i--) {
    size += at(i).size
    if (size > BUDGET && newer < start) break
    newer = i
  }
  const came = back.at(-1)
  if (came !== undefined && came < start) newer = came
  const total = `${shown.length}${d.hasMore ? '+' : ''}`
  const canOlder = end < shown.length || d.hasMore
  const count = !q ? `Rows ${start + 1}–${end} of ${total}` : shown.length ? `${start + 1}–${end} of ${total} matching “${q}”` : `Nothing matches “${q}”${d.hasMore ? ' yet: Show older commits searches further' : ''}`

  return keep(
    <Box flexDirection="column">
      {header(count)}
      {columnHeads}
      {start > 0 && (
        <Box marginY={1}>
          <Button key="newer" label="Show newer commits" onPress={() => void showNewer($, newer)} />
        </Box>
      )}
      {rows}
      {canOlder && (
        <Box marginTop={1}>
          <Button key="older" label="Show older commits" onPress={() => void showOlder($, start, end, shown.length, d.hasMore)} />
        </Box>
      )}
    </Box>
  )
}
