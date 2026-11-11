// Pane flows recorded against a scratch copy of the playground (dev/record.ts)
// and replayed by tests/flows.test.tsx. Plain data, read by both.

// Which row a step acts on, looked up in the state before it.
export type Sel = { working: true } | { stash: number } | { subject: string } | { ref: string }

export type Step = { at: Sel; action: string; value?: string; choice?: string }

// `setup` runs in the scratch copy (each an argv after `git`, '?' first where it may fail) before recording starts.
// `open` names rows whose details a test opens without a step; `narrow`, branches (full ref
// names) whose history alone the graph is also read for, as the branch filter asks.
export type Scenario = { name: string; setup?: string[][]; open?: Sel[]; narrow?: string[]; steps: Step[] }

// A clean tree for flows the seeded changes would block; they wait in a stash.
const CLEAN = [['stash', 'push', '-u', '-m', 'Seeded changes']]
const HEAD = { ref: 'main' }

export const SCENARIOS: Scenario[] = [
  { name: 'browse', open: [{ ref: 'main' }], narrow: ['refs/heads/feature/search', 'refs/heads/main'], steps: [] },
  { name: 'stash-pop', steps: [{ at: { stash: 0 }, action: 'stash:pop' }] },
  // The seeded tree has src/app.js staged: stash it, then pop it back staged.
  { name: 'stash-pop-index', setup: [['stash', 'push', '-m', 'Staged and not']], steps: [{ at: { stash: 0 }, action: 'stash:pop', choice: 'index' }] },
  // stash@{1} touches src/app.js, which the seeded tree has changed too.
  { name: 'stash-apply-dirty', steps: [{ at: { stash: 1 }, action: 'stash:apply' }] },
  {
    name: 'stash-ops',
    setup: CLEAN,
    steps: [
      { at: { stash: 1 }, action: 'stash:apply' },
      { at: { stash: 2 }, action: 'stash:drop' },
      { at: { stash: 0 }, action: 'stash:branch', value: 'from-stash' },
    ],
  },
  { name: 'stash-push', steps: [{ at: { working: true }, action: 'working:stash', value: 'wip test', choice: 'yes' }] },
  { name: 'discard-tracked', steps: [{ at: { working: true }, action: 'working:discard' }] },
  { name: 'discard-all', steps: [{ at: { working: true }, action: 'working:discard', choice: 'all' }] },
  {
    name: 'branch-life',
    steps: [
      { at: HEAD, action: 'commit:branch', value: 'spike', choice: 'stay' },
      { at: { ref: 'spike' }, action: 'branch:spike:push' },
      { at: { ref: 'spike' }, action: 'branch:spike:rename', value: 'spike-2' },
      { at: { ref: 'spike-2' }, action: 'branch:spike-2:delete' },
      { at: { ref: 'origin/spike' }, action: 'remote:origin/spike:delete' },
    ],
  },
  { name: 'branch-checkout-new', steps: [{ at: { subject: 'Add divide helper' }, action: 'commit:branch', value: 'from-divide' }] },
  {
    name: 'branch-delete-force',
    steps: [
      { at: { ref: 'experiment/local-only' }, action: 'branch:experiment/local-only:delete' },
      { at: { ref: 'experiment/local-only' }, action: 'branch:experiment/local-only:delete', choice: '-D' },
    ],
  },
  {
    name: 'remote-branches',
    setup: CLEAN,
    steps: [
      { at: { ref: 'origin/feature/old-api' }, action: 'remote:origin/feature/old-api:checkout' },
      { at: { ref: 'feature/login' }, action: 'branch:feature/login:delete-remote' },
    ],
  },
  {
    name: 'tags',
    steps: [
      { at: { ref: 'v0.1' }, action: 'tag:v0.1:push' },
      { at: HEAD, action: 'commit:tag', value: 'v2.0' },
      { at: { ref: 'v2.0' }, action: 'tag:v2.0:push' },
      { at: { ref: 'v2.0' }, action: 'tag:v2.0:delete' },
    ],
  },
  { name: 'pull', setup: [...CLEAN, ['reset', '-q', '--hard', 'HEAD~1']], steps: [{ at: HEAD, action: 'branch:main:pull' }] },
  {
    name: 'commit-ops',
    setup: CLEAN,
    steps: [
      { at: { subject: 'Try a wild idea' }, action: 'commit:cherry-pick' },
      { at: { subject: 'Add licence section' }, action: 'commit:revert' },
      { at: { subject: 'Add divide helper' }, action: 'commit:reset', choice: 'soft' },
      { at: { ref: 'origin/main' }, action: 'commit:reset', choice: 'mixed' },
      { at: { subject: 'Add divide helper' }, action: 'commit:reset', choice: 'hard' },
    ],
  },
  {
    name: 'merge-conflict',
    setup: CLEAN,
    steps: [
      { at: { ref: 'feature/search' }, action: 'branch:feature/search:merge' },
      { at: { working: true }, action: 'working:abort' },
    ],
  },
  // Continue refuses while markers remain, and runs once the file is resolved (taken as theirs).
  {
    name: 'merge-continue',
    setup: [...CLEAN, ['?', 'merge', '--no-edit', 'feature/search']],
    steps: [{ at: { working: true }, action: 'working:continue' }],
  },
  {
    name: 'merge-continue-resolved',
    setup: [...CLEAN, ['?', 'merge', '--no-edit', 'feature/search'], ['checkout', '--theirs', 'src/app.js']],
    steps: [{ at: { working: true }, action: 'working:continue' }],
  },
]
