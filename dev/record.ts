// Records real git output for each scenario into tests/fixtures/<name>.ts.
// Runs with bun, outside the mod: `GITVIEW_PLAYGROUND=<repo> bun dev/record.ts [name...]`,
// where <repo> is a demo repository holding the branches, tags and stashes the scenarios
// in tests/scenarios.ts name. Works only in a scratch copy of it whose origin is a local
// bare repo, so nothing touches the demo repository itself or its remote.
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Commit } from '../types'
import { groupsFor } from '../hooks/actions'
import { loadDetails, loadDiff, loadGraph } from '../hooks/git'
import type { Run } from '../hooks/git'
import { SCENARIOS } from '../tests/scenarios'
import type { Sel } from '../tests/scenarios'

const PLAYGROUND = process.env.GITVIEW_PLAYGROUND ?? ''
if (!PLAYGROUND) throw new Error('set GITVIEW_PLAYGROUND to the demo repository to record from')
const LIMIT = 200 // the pane's first page
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', LC_ALL: 'C' }

type Out = { exitCode: number; stdout: string; stderr: string }

function scratch() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'gitview-rec-')))
  const repo = join(tmp, 'repo')
  const origin = join(tmp, 'origin.git')
  cpSync(PLAYGROUND, repo, { recursive: true })
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, env: ENV, encoding: 'utf8' })
  execFileSync('git', ['init', '-q', '--bare', origin])
  g('remote', 'set-url', 'origin', origin)
  if (g('remote', 'get-url', 'origin').trim() !== origin) throw new Error('origin was not redirected')
  g('push', '-q', origin, 'refs/remotes/origin/*:refs/heads/*', 'refs/tags/*:refs/tags/*')
  g('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  return { tmp, repo }
}

function runIn(repo: string, argv: string[]): Out {
  if (!realpathSync(repo).startsWith(realpathSync(tmpdir()))) throw new Error(`refusing to run outside the scratch copy: ${repo}`)
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd: repo, env: ENV, encoding: 'utf8', maxBuffer: 64 << 20 })
  return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
}

function find(commits: Commit[], at: Sel): Commit | undefined {
  if ('working' in at) return commits.find(c => c.kind === 'working')
  if ('stash' in at) return commits.find(c => c.kind === 'stash' && c.refs[0] === `stash@{${at.stash}}`)
  if ('subject' in at) return commits.find(c => c.kind === 'commit' && c.subject === at.subject)
  return commits.find(c => c.refs.some(r => r.replace(/^HEAD -> |^tag: /, '') === at.ref))
}

// Every read the pane makes in this state: the graph, and the details and diffs
// of the rows the scenario opens, plus the uncommitted and stash rows.
async function snapshot(repo: string, targets: Sel[], hashes: string[], narrow: string[]) {
  const reads: Record<string, Out> = {}
  const run: Run = async argv => (reads[JSON.stringify(argv)] ??= runIn(repo, argv))
  const g = await loadGraph(run, LIMIT)
  for (const ref of narrow) await loadGraph(run, LIMIT, ref)
  const open = new Set<Commit>(g.commits.filter(c => c.kind !== 'commit'))
  for (const t of targets) {
    const c = find(g.commits, t)
    if (c) open.add(c)
  }
  // Rows opened in an earlier step stay open, so their details load again.
  for (const h of hashes) {
    const c = g.commits.find(x => x.hash === h)
    if (c) open.add(c)
  }
  for (const c of open) {
    const d = await loadDetails(run, c)
    for (const f of d.files) await loadDiff(run, c, f)
  }
  return { reads, graph: g }
}

for (const s of SCENARIOS.filter(s => process.argv.length < 3 || process.argv.includes(s.name))) {
  const { tmp, repo } = scratch()
  try {
    for (const step of s.setup ?? []) {
      // A setup step starting '?' may fail (a merge left on a conflict, say).
      const mayFail = step[0] === '?'
      const argv = mayFail ? step.slice(1) : step
      const r = runIn(repo, ['git', ...argv])
      if (r.exitCode !== 0 && !mayFail) throw new Error(`setup git ${argv.join(' ')}: ${r.stderr}`)
    }
    const targets = [...s.steps.map(st => st.at), ...(s.open ?? [])]
    const hashes: string[] = []
    let snap = await snapshot(repo, targets, hashes, s.narrow ?? [])
    const states = [snap.reads]
    const steps = []
    for (const st of s.steps) {
      const g = snap.graph
      const c = find(g.commits, st.at)
      if (!c) throw new Error(`${s.name}: no row for ${JSON.stringify(st.at)}`)
      const action = groupsFor(c, g).flatMap(x => x.actions).find(a => a.id === st.action)
      if (!action?.run) throw new Error(`${s.name}: no action ${st.action} on ${c.hash}`)
      const value = st.value ?? action.input?.value ?? ''
      const choice = st.choice ?? action.choice?.options[0]?.value ?? ''
      const argv = action.run(value, choice).map(a => ['git', ...a])
      const results: Out[] = []
      for (const a of argv) {
        const r = runIn(repo, a)
        results.push(r)
        if (r.exitCode !== 0) break
      }
      hashes.push(c.hash)
      snap = await snapshot(repo, targets, hashes, s.narrow ?? [])
      states.push(snap.reads)
      steps.push({ ...st, hash: c.hash, argv: argv.slice(0, results.length), results })
      if (process.env.DEBUG) console.log(st.action, c.hash.slice(0, 7), results.map(r => r.exitCode + " " + (r.stdout + r.stderr).trim().slice(0, 200)))
    }
    const file = join(import.meta.dir, '../tests/fixtures', `${s.name}.ts`)
    writeFileSync(file, `// Recorded by dev/record.ts: do not edit.\nexport default ${JSON.stringify({ name: s.name, steps, states })} as const\n`)
    console.log(`${s.name}: ${states.length} states, ${steps.map(x => x.results.map(r => r.exitCode).join('/')).join(' ')}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
