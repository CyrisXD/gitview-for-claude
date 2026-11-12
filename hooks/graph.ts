import type { Commit, CommitKind } from '../types'

// Fields split by \x1f, records by \x1e: subjects can hold anything else.
export const FORMAT = '--format=%H%x1f%P%x1f%D%x1f%an%x1f%ad%x1f%s%x1e'
export const DATE = '--date=format:%d %b %Y %H:%M'
export const WORKING = 'WORKING'

const HEX = /^[0-9a-f]{4,64}$/
const DATED = /^\d\d \w{3} \d{4} \d\d:\d\d$/ // what DATE prints

// A commit's author and subject may hold \x1f or \x1e themselves, and a subject holding \x1e reads as
// the start of another record: one with any hash it likes (`--hard`), which an action would hand to git.
// So a record counts only when its hash and parents are hex, and its author and subject are what lies
// either side of the date. A forged record's text stays in the subject before it, where it belongs.
export function parseLog(out: string, kind: CommitKind = 'commit'): Commit[] {
  const commits: Commit[] = []
  for (const rec of out.split('\x1e')) {
    const f = rec.replace(/^\n+/, '').split('\x1f')
    const at = f.findIndex((x, i) => i > 3 && DATED.test(x))
    const parents = (f[1] ?? '').split(' ').filter(Boolean)
    const ok = f.length >= 6 && HEX.test(f[0]!) && parents.every(p => HEX.test(p)) && at > 3
    const last = commits.at(-1)
    if (!ok) {
      if (last && rec) last.subject += `\x1e${rec}`.replace(/[\x1e\x1f]/g, ' ').replace(/\s+$/, '')
      continue
    }
    commits.push({
      kind,
      hash: f[0]!,
      parents,
      refs: f[2]!.split(', ').filter(Boolean),
      author: f.slice(3, at).join(' '),
      date: f[at]!,
      subject: f.slice(at + 1).join(' '),
    })
  }
  return commits
}

// Puts each stash directly above its base commit, and the uncommitted
// changes row on top; a stash whose base is not loaded is left out.
export function merge(commits: Commit[], stashes: Commit[], working: Commit | null): Commit[] {
  const byBase = new Map<string, Commit[]>()
  for (const s of stashes) {
    const base = s.parents[0]
    if (base) byBase.set(base, [...(byBase.get(base) ?? []), { ...s, parents: [base] }])
  }
  const out: Commit[] = working ? [working] : []
  for (const c of commits) out.push(...(byBase.get(c.hash) ?? []), c)
  return out
}

// One segment of a line, from row r1 to r2 (r2 = r1 + 1), x in lane units.
export type Edge = { x1: number; r1: number; x2: number; r2: number; lane: number }
export type Layout = { cols: number[]; edges: Edge[]; lanes: number }
// A history with dozens of open branches made the graph wider than the pane, and the
// description column (subjects and badges) got no room at all.
export const MAX_LANES = 10

// Lanes hold the hash each is waiting for. A commit takes the lane waiting
// for it (or a free one), hands it to its first parent and opens lanes for
// the others; every other lane waiting for it converges on its node.
export function layout(commits: Commit[]): Layout {
  const lanes: (string | null)[] = []
  const cols: number[] = []
  const gaps: { from: number; lane: number; hash: string }[][] = []
  const free = () => {
    const i = lanes.indexOf(null)
    return i === -1 ? lanes.push(null) - 1 : i
  }
  let width = 1

  for (const c of commits) {
    let col = lanes.indexOf(c.hash)
    if (col === -1) col = free()
    for (let j = 0; j < lanes.length; j++) if (lanes[j] === c.hash) lanes[j] = null

    const origin = new Map<number, number>()
    const extra: { from: number; lane: number; hash: string }[] = []
    c.parents.forEach((p, k) => {
      if (k === 0) {
        lanes[col] = p
        origin.set(col, col)
        return
      }
      const at = lanes.indexOf(p)
      if (at !== -1) {
        extra.push({ from: col, lane: at, hash: p })
        return
      }
      const slot = free()
      lanes[slot] = p
      origin.set(slot, col)
    })
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()

    width = Math.max(width, lanes.length, col + 1)
    cols.push(col)
    gaps.push([
      ...lanes.flatMap((hash, j) => (hash === null ? [] : [{ from: origin.get(j) ?? j, lane: j, hash }])),
      ...extra,
    ])
  }

  const edges = gaps.flatMap((gap, r) =>
    gap.map(g => ({
      x1: g.from,
      r1: r,
      x2: commits[r + 1]?.hash === g.hash ? cols[r + 1]! : g.lane,
      r2: r + 1,
      lane: g.lane,
    })),
  )
  // Lanes past the cap are clipped at the graph's right edge, so the description keeps its room.
  return { cols, edges, lanes: Math.min(width, MAX_LANES) }
}

export const ROW_PX = 28
const LANE = 16
// Room between lanes, in px: a busy graph fits narrow, or spreads out so its crossings read.
export const SPACING = { compact: 10, normal: LANE, wide: 26 } as const
export type Spacing = keyof typeof SPACING
const PAD = 10
// The Claude desktop app's muted tones (mineral and plum from its stylesheet), with sky, ochre,
// olive, rose, red and stone picked at the same softness. No clay orange, by request.
export const COLORS = ['#6a9bcc', '#629987', '#827dbd', '#c9a14a', '#788c5d', '#c4767f', '#d0605e', '#8e8a7e']
const GREY = '#898781' // the app's warm grey

export const laneColor = (lane: number) => COLORS[lane % COLORS.length]!
export const graphWidth = (lanes: number, lane: number = LANE) => PAD * 2 + (lanes - 1) * lane

// Each row draws its own slice of the graph: the lower half of every line
// leaving it and the upper half of every line arriving, so stacked rows of
// equal height join up. A curve is one cubic split at the row boundary.
export function rowSvg(commits: Commit[], lay: Layout, r: number, isHead: boolean, gap: number = LANE): string {
  const H = ROW_PX
  const W = graphWidth(lay.lanes, gap)
  const x = (lane: number) => PAD + lane * gap
  const c = commits[r]!
  const paths: string[] = []
  const stroke = (e: Edge) => {
    const dashed = commits[e.r1]!.kind !== 'commit'
    return `stroke="${dashed ? GREY : laneColor(e.lane)}"${dashed ? ' stroke-dasharray="3 3"' : ''}`
  }

  for (const e of lay.edges) {
    const [x1, x2] = [x(e.x1), x(e.x2)]
    const xm = (x1 + x2) / 2
    if (e.r1 === r) {
      const d =
        x1 === x2
          ? `M${x1} ${H / 2}V${H}`
          : `M${x1} ${H / 2}C${x1} ${(3 * H) / 4},${(3 * x1 + x2) / 4} ${(7 * H) / 8},${xm} ${H}`
      paths.push(`<path d="${d}" ${stroke(e)}/>`)
    } else if (e.r2 === r) {
      const d =
        x1 === x2 ? `M${x2} 0V${H / 2}` : `M${xm} 0C${(x1 + 3 * x2) / 4} ${H / 8},${x2} ${H / 4},${x2} ${H / 2}`
      paths.push(`<path d="${d}" ${stroke(e)}/>`)
    }
  }

  const cx = x(Math.min(lay.cols[r]!, lay.lanes - 1)) // a commit on a clipped lane sits at the edge
  const cy = H / 2
  const color = laneColor(lay.cols[r]!)
  let node: string
  if (c.kind === 'working')
    node = `<circle cx="${cx}" cy="${cy}" r="4.5" fill="none" stroke="${GREY}" stroke-width="2" stroke-dasharray="2 2"/>`
  else if (c.kind === 'stash')
    node = `<circle cx="${cx}" cy="${cy}" r="5" fill="none" stroke="${GREY}" stroke-width="1.5"/><circle cx="${cx}" cy="${cy}" r="2" fill="${GREY}"/>`
  else if (isHead) node = `<circle cx="${cx}" cy="${cy}" r="4.5" fill="none" stroke="${color}" stroke-width="2.5"/>`
  else node = `<circle cx="${cx}" cy="${cy}" r="4" fill="${color}"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><g fill="none" stroke-width="2">${paths.join('')}</g>${node}</svg>`
}

export type Badge = { label: string; kind: 'head' | 'branch' | 'remote' | 'tag' | 'stash'; isSynced: boolean }

// Badges for a row: a local branch and its remote twin on
// the same commit show as one badge (isSynced); remote HEADs are dropped.
// `locals`: the local branch names, so a local branch called origin/x is not taken for a remote one.
export function badges(c: Commit, remotes: string[], locals: string[] = []): Badge[] {
  if (c.kind === 'stash') return c.refs.map(label => ({ label, kind: 'stash' as const, isSynced: false }))
  const isRemote = (name: string) => remotes.some(r => name.startsWith(`${r}/`))
  const names = c.refs.map(r => r.replace(/^HEAD -> /, ''))
  const out: Badge[] = []
  for (const ref of c.refs) {
    if (ref === 'HEAD') continue
    if (ref.startsWith('tag: ')) {
      out.push({ label: ref.slice(5), kind: 'tag', isSynced: false })
      continue
    }
    const name = ref.replace(/^HEAD -> /, '')
    if (isRemote(name) && !locals.includes(name)) {
      const short = name.slice(name.indexOf('/') + 1)
      if (short === 'HEAD' || names.includes(short)) continue
      out.push({ label: name, kind: 'remote', isSynced: false })
      continue
    }
    out.push({
      label: name,
      kind: ref.startsWith('HEAD -> ') ? 'head' : 'branch',
      isSynced: remotes.some(r => names.includes(`${r}/${name}`)),
    })
  }
  return out
}

export const isHeadCommit = (c: Commit) => c.kind === 'commit' && c.refs.some(r => r === 'HEAD' || r.startsWith('HEAD -> '))

// How a badge paints. Where the surface draws see-through colour (the apps) a ref is a soft tint
// of its lane with the name in the lane's colour, and the checked-out branch alone is solid, so it
// stands out; the terminal has no see-through colour, so there they stay solid.
export function badgeStyle(kind: Badge['kind'], lane: string, isTinted: boolean) {
  const OCHRE = '#c9a14a'
  if (!isTinted) {
    if (kind === 'tag') return { backgroundColor: '#a8803a', color: '#ffffff' }
    if (kind === 'head' || kind === 'branch') return { backgroundColor: lane, color: '#ffffff', bold: kind === 'head' }
    return { color: kind === 'stash' ? GREY : lane, italic: kind === 'remote' }
  }
  switch (kind) {
    case 'head':
      return { backgroundColor: lane, color: '#ffffff', bold: true }
    case 'branch':
      return { backgroundColor: `${lane}33`, color: lane }
    case 'remote':
      return { backgroundColor: `${lane}14`, color: lane, italic: true }
    case 'tag':
      return { backgroundColor: `${OCHRE}33`, color: OCHRE }
    default:
      return { backgroundColor: `${GREY}1f`, color: GREY }
  }
}


// A desktop badge as a rounded pill: Box and Text have no corner radius, an Svg does.
// Monospace, so the width follows from the label's length (no text measuring in an image).
export const BADGE_PX = { height: 18, char: 6.6, pad: 7 }
export function badgeSvg(kind: Badge['kind'], text: string, lane: string) {
  const s = badgeStyle(kind, lane, true)
  const width = Math.ceil(text.length * BADGE_PX.char + BADGE_PX.pad * 2)
  const h = BADGE_PX.height
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}">` +
    `<rect width="${width}" height="${h}" rx="${h / 2}" fill="${s.backgroundColor}"/>` +
    `<text x="${width / 2}" y="${h / 2}" dominant-baseline="central" text-anchor="middle" fill="${s.color}"` +
    ` font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="11"` +
    `${'bold' in s && s.bold ? ' font-weight="600"' : ''}${'italic' in s && s.italic ? ' font-style="italic"' : ''}>${esc}</text></svg>`
  return { source, width, height: h }
}
