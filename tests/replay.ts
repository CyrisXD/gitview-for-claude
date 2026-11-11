// Replays a recorded scenario: git answers from the fixture's current state, and
// each command an action runs must be the next one the recording ran, which
// moves the replay to the state recorded after that step.
type Out = { exitCode: number; stdout: string; stderr: string }
type Fixture = {
  name: string
  steps: readonly { action: string; hash: string; value?: string; choice?: string; argv: readonly (readonly string[])[]; results: readonly Out[] }[]
  states: readonly Record<string, Out>[]
}

export const PANE = {
  plugin: 'gitview',
  component: 'Pane',
  requestId: 'gitview',
  props: { title: 'Gitview', isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const HARDENED = new Set(['core.fsmonitor=false', '--no-ext-diff', '--no-textconv'])
const value = (o: Out) => ({ value: { ...o, isStdoutTruncated: false, isStderrTruncated: false } })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// `slow` makes the reads it matches wait on the mock clock (ms), so a test can act while they run.
export function replay(on: any, fx: Fixture, slow?: { clock: { sleep(ms: number): Promise<void> }; when: (argv: string[]) => number }) {
  const log = { state: 0, step: 0, cmd: 0, ran: [] as string[], missing: [] as string[], unexpected: [] as string[], toasts: [] as string[], copied: [] as string[] }
  on('command.register', () => ({ value: { command: 'gitview' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_: unknown, e: { text: string }) => (log.toasts.push(e.text), { value: undefined }))
  on('ui.copy', (_: unknown, e: { text: string }) => (log.copied.push(e.text), { value: { isCopied: true } }))
  on('process.run', async (_: unknown, e: { argv: string[] }) => {
    const key = JSON.stringify(e.argv)
    // Fixtures recorded before the reads were hardened have their commands without these.
    const old = JSON.stringify(e.argv.filter((a, i, all) => !HARDENED.has(a) && !(a === '-c' && HARDENED.has(all[i + 1]!))))
    const wait = slow?.when(e.argv) ?? 0
    if (wait) await slow!.clock.sleep(wait)
    // The pane's reads all start `git -c core.quotepath=false`; an action's commands do not.
    if (e.argv[2] === 'core.quotepath=false') {
      const hit = fx.states[log.state]![key] ?? fx.states[log.state]![old]
      if (hit) return value(hit)
      log.missing.push(`state ${log.state}: ${e.argv.join(' ')}`)
      return value({ exitCode: 128, stdout: '', stderr: 'not recorded' })
    }
    log.ran.push(e.argv.join(' '))
    const st = fx.steps[log.step]
    const want = st?.argv[log.cmd]
    if (!st || !want || JSON.stringify(want) !== key) {
      log.unexpected.push(e.argv.join(' '))
      return value({ exitCode: 1, stdout: '', stderr: 'unexpected command' })
    }
    const out = st.results[log.cmd]!
    log.cmd++
    if (log.cmd === st.argv.length) {
      log.step++
      log.cmd = 0
      log.state++
    }
    return value(out)
  })
  return log
}

type Ui = {
  press(t: { key: string }): Promise<unknown>
  input(t: { key: string; text: string }): Promise<unknown>
  select(t: { key: string; value: string }): Promise<unknown>
  find(q: { key?: string; type?: string; text?: string | RegExp }): Promise<{ text?: string } | undefined>
}

// Pages to where `here()` holds as a person would: back to the newest rows, then Show older
// until it does. Each loop is bounded, so a window that stops moving fails instead of hanging.
export async function goTo(ui: Ui, here: () => Promise<boolean>, what = 'it') {
  const rows = async () => (await ui.find({ type: 'Text', text: /^Rows / }))?.text
  let n = 0
  if (!(await here()))
    while (await ui.find({ key: 'newer' })) {
      if (++n > 50) throw new Error(`Show newer does not move: ${await rows()}`)
      await ui.press({ key: 'newer' })
    }
  while (!(await here()) && (await ui.find({ key: 'older' }))) {
    if (++n > 100) throw new Error(`Show older does not reach ${what}: ${await rows()}`)
    await ui.press({ key: 'older' })
  }
}

// Does step i through the pane as a person would: open the row, pick the action,
// make its choice, type its value, confirm.
export async function act(ui: Ui, fx: Fixture, i: number) {
  const st = fx.steps[i]!
  if (!(await findAction(ui as never, st.hash, st.action))) {
    await goTo(ui, async () => !!(await ui.find({ key: `c:${st.hash}` })), st.hash)
    await ui.press({ key: `c:${st.hash}` })
  }
  await pick(ui as never, st.hash, st.action)
  if (st.choice !== undefined) await ui.select({ key: `choice:${st.action}`, value: st.choice })
  if (await ui.find({ key: `input:${st.action}` })) await ui.input({ key: `input:${st.action}`, text: st.value ?? '' })
  else await ui.press({ key: `run:${st.action}` })
}

// The drawing as text, one line per row-ish Box, for reading what a step drew.
type El = { type: string; props?: Record<string, unknown>; children?: unknown[] }
export function dump(el: unknown, depth = 0): string {
  if (el == null || el === false) return ''
  if (typeof el === 'string' || typeof el === 'number') return String(el)
  if (Array.isArray(el)) return el.map(x => dump(x, depth)).join('')
  const e = el as El
  const p = e.props ?? {}
  const kids = (e.children ?? (p.children as unknown[] | undefined) ?? []) as unknown[]
  const inner = Array.isArray(kids) ? kids.map(k => dump(k, depth + 1)).join(e.type === 'Box' && p.flexDirection === 'column' ? '\n' : ' ') : dump(kids, depth + 1)
  switch (e.type) {
    case 'Button': return `[${p.label ?? inner}]{${p.key ?? ''}}`
    case 'Svg': return '⎔'
    case 'Select': return `<${p.label}: ${p.value} of ${(p.options as { value: string }[]).map(o => o.value).join('|')}>{${p.key}}`
    case 'Input': return `<${p.label} "${p.value}">{${p.key}}`
    case 'Code': return `\n\`\`\`${p.format}\n${p.source}\n\`\`\``
    case 'Text': return p.color && typeof p.color === 'string' ? `${inner}` : inner
    default: return inner
  }
}

// A badge by its label: a Text ` label ` on the terminal, a pill whose alt is `<kind> label` on the desktop.
type Finder = { findAll(q: object): Promise<readonly { key?: string; text?: string; props?: Record<string, unknown> }[]> }
export async function badge(ui: Finder, label: string) {
  const exact = new RegExp(`^ ${label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} $`)
  const texts = await ui.findAll({ type: 'Text', text: exact })
  if (texts.length) return texts[0]
  const pills = await ui.findAll({ type: 'Svg' })
  return pills.find(p => {
    const alt = String(p.props?.alt ?? '')
    return alt.slice(alt.indexOf(' ') + 1) === label
  })
}

// An action by id on a row: the group dropdown that lists it (or, where no Select is drawn, its button).
type Picker = Finder & { select(t: { key: string; value: string }): Promise<unknown>; press(t: { key: string }): Promise<unknown> }
export async function findAction(ui: Picker, hash: string, id: string) {
  const menus = await ui.findAll({ type: 'Select' })
  const menu = menus.find(m => m.key?.startsWith(`g:${hash}:`) && (m.props?.options as { value: string }[]).some(o => o.value === id))
  return menu ?? (await ui.findAll({ key: `a:${hash}:${id}` }))[0]
}
export async function pick(ui: Picker, hash: string, id: string) {
  const el = await findAction(ui, hash, id)
  if (!el?.key) throw new Error(`no action ${id} on ${hash}`)
  if (el.key.startsWith('g:')) await ui.select({ key: el.key, value: id })
  else await ui.press({ key: el.key })
}
