// The column heads as a Client: the dividers between Description, Date, Author
// and Commit can be dragged. Each drag posts the widths to the hooks module,
// which redraws the rows with them.
import type { ClientModule } from 'claude-code'

import type { Widths } from '../types'

export type HeadProps = { widths: Widths; showDate: boolean }
type State = { drag: keyof Widths | null; widths: Widths | null }

const NAMES = { date: 'Date', author: 'Author', commit: 'Commit' } as const

export const MIN = 4 // narrowest a fixed column goes
export const DESC_MIN = 12 // room Description always keeps

// Columns right to left, each with the divider at its left edge. The rows draw
// [Description] gap [Date] gap [Author] gap [Commit], so the gaps hold the dividers.
export function dividers(w: Widths, showDate: boolean, columns: number) {
  const out: { col: keyof Widths; x: number }[] = []
  let right = columns
  for (const col of (showDate ? ['commit', 'author', 'date'] : ['commit', 'author']) as (keyof Widths)[]) {
    right -= w[col] + 1
    out.push({ col, x: right })
  }
  return out
}

// Dragging a column's divider to x makes that column span from x to the next divider on its right.
export function dragTo(w: Widths, showDate: boolean, columns: number, col: keyof Widths, x: number): Widths {
  const ds = dividers(w, showDate, columns)
  const i = ds.findIndex(d => d.col === col)
  const rightEdge = i === 0 ? columns : ds[i - 1]!.x
  // Columns to its left (and Description's least) keep their room.
  const leftLimit = DESC_MIN + ds.slice(i + 1).reduce((n, d) => n + w[d.col] + 1, 0)
  const width = Math.max(MIN, Math.min(rightEdge - 1 - Math.max(x, leftLimit), 60))
  return { ...w, [col]: width }
}

// The listener is set once, so it reads each instance's newest props here (the surface is the same object every call).
const latest = new WeakMap<object, HeadProps>()

const Columns: ClientModule<HeadProps, State> = (props, s) => {
  latest.set(s, props)
  const { Text } = s.elements
  const st = s.state ?? { drag: null, widths: null }
  const w = st.drag && st.widths ? st.widths : props.widths
  if (!s.state) {
    s.onPointer(e => {
      const p = latest.get(s)!
      const cur = s.state ?? { drag: null, widths: null }
      const live = (cur.drag && cur.widths) || p.widths
      if (e.type === 'down' && e.button === 'left') {
        // A press within two cells of a divider picks it up (dividers sit at least 5 apart).
        const hit = dividers(live, p.showDate, s.columns).find(d => Math.abs(d.x - e.x) <= 2)
        if (hit) s.setState({ drag: hit.col, widths: live })
      } else if (e.type === 'move' && cur.drag) {
        const next = dragTo(live, p.showDate, s.columns, cur.drag, e.x)
        s.setState({ drag: cur.drag, widths: next })
        s.post({ widths: next })
      } else if (e.type === 'up' && cur.drag) {
        s.setState({ drag: null, widths: null })
        s.post({ widths: live })
      }
    })
    s.setState(st)
  }
  // Boxes of the rows' own widths, not a padded string: the desktop draws text in a
  // proportional font, so spaces never lined the dividers up with the rows there.
  const { Box } = s.elements
  const label = (text: string, extra: Record<string, unknown>) =>
    Box({ ...extra, overflow: 'hidden', children: Text({ dimColor: true, bold: true, wrap: 'truncate', children: text }) })
  const ds = dividers(w, props.showDate, s.columns).reverse()
  return Box({
    flexDirection: 'row',
    children: [
      label('Description', { flexGrow: 1, flexShrink: 1, minWidth: 0 }),
      ...ds.flatMap(d => [
        Box({ width: 1, flexShrink: 0, children: Text({ dimColor: d.col !== st.drag, bold: true, children: d.col === st.drag ? '┃' : '│' }) }),
        // While dragged the head says its width: the desktop redraws the rows only on release.
        label(`${NAMES[d.col]}${d.col === st.drag ? ` · ${w[d.col]}` : ''}`, { key: `head:${d.col}`, width: w[d.col], flexShrink: 0 }),
      ]),
    ],
  })
}

export default Columns
