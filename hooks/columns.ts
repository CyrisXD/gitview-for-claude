// The column heads as a Client, laid out as a spreadsheet's: every column (the graph first) has a
// divider at its right edge, and dragging it sizes that column alone while the columns after it
// move along at their own widths. Description fills what is left until its own edge is dragged,
// so until then it is the one that gives and takes. Each drag posts the widths to the hooks module,
// which redraws the rows with them.
import type { ClientModule } from 'claude-code'

import type { Widths } from '../types'

export type Col = keyof Widths
// The widths as drawn: the graph's resolved, Description's null while it fills.
export type HeadProps = { widths: Omit<Widths, 'graph'> & { graph: number }; showDate: boolean }
type State = { drag: Col | null; widths: HeadProps['widths'] | null }

const NAMES: Record<Col, string> = { graph: '', desc: 'Description', date: 'Date', author: 'Author', commit: 'Commit' }

export const MIN = 4 // narrowest a column goes
export const DESC_MIN = 12 // room Description keeps while it fills
export const MAX = 200

// Each column's left edge and width, in order; the divider of a column is the gap cell at its right.
export function columns(w: HeadProps['widths'], showDate: boolean, room: number) {
  const order: Col[] = showDate ? ['graph', 'desc', 'date', 'author', 'commit'] : ['graph', 'desc', 'author', 'commit']
  const fixed = order.filter(c => c !== 'desc').reduce((n, c) => n + (w[c] as number) + 1, 0)
  let left = 0
  return order.map(col => {
    const width = col === 'desc' ? (w.desc ?? Math.max(DESC_MIN, room - fixed - 1)) : (w[col] as number)
    const at = { col, left, width, divider: left + width }
    left += width + 1
    return at
  })
}

// Dragging a column's divider to x makes that column end there; nothing else changes width.
export function dragTo(w: HeadProps['widths'], showDate: boolean, room: number, col: Col, x: number): HeadProps['widths'] {
  const at = columns(w, showDate, room).find(c => c.col === col)!
  return { ...w, [col]: Math.max(MIN, Math.min(MAX, Math.round(x) - at.left)) }
}

// The listener is set once, so it reads each instance's newest props here (the surface is the same object every call).
const latest = new WeakMap<object, HeadProps>()

const Columns: ClientModule<HeadProps, State> = (props, s) => {
  latest.set(s, props)
  const { Box, Text } = s.elements
  const st = s.state ?? { drag: null, widths: null }
  const w = st.drag && st.widths ? st.widths : props.widths
  if (!s.state) {
    s.onPointer(e => {
      const p = latest.get(s)!
      const cur = s.state ?? { drag: null, widths: null }
      const live = (cur.drag && cur.widths) || p.widths
      if (e.type === 'down' && e.button === 'left') {
        // The nearest divider within two cells of the press.
        const near = columns(live, p.showDate, s.columns)
          .map(c => ({ col: c.col, d: Math.abs(c.divider - e.x) }))
          .filter(c => c.d <= 2)
          .sort((a, b) => a.d - b.d)[0]
        if (near) s.setState({ drag: near.col, widths: live })
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
  const label = (text: string, extra: Record<string, unknown>) =>
    Box({ ...extra, flexShrink: 0, overflow: 'hidden', children: Text({ dimColor: true, bold: true, wrap: 'truncate', children: text }) })
  return Box({
    flexDirection: 'row',
    overflow: 'hidden',
    children: columns(w, props.showDate, s.columns).flatMap(c => [
      // While dragged the head says its width: the desktop redraws the rows only on release.
      label(`${NAMES[c.col]}${c.col === st.drag ? ` · ${c.width}` : ''}`, { key: `head:${c.col}`, width: c.width }),
      Box({ width: 1, flexShrink: 0, children: Text({ dimColor: c.col !== st.drag, bold: true, children: c.col === st.drag ? '┃' : '│' }) }),
    ]),
  })
}

export default Columns
