import type { Commit, Operation } from '../types'
import { badges } from './graph'

// What a pane action does once confirmed: git commands run in order (each an
// argv after `git`), or text put on the clipboard.
export type Action = {
  id: string
  label: string
  isDanger?: boolean
  // Asked for before running: a name (branch, tag, stash message).
  input?: { label: string; value?: string; isOptional?: boolean }
  // A pick before running (reset mode, delete force); the first is the default.
  choice?: { label: string; options: { value: string; label: string }[] }
  run?: (value: string, choice: string) => string[][]
  copy?: string
}

export type Group = { title: string; actions: Action[] }

export type Context = {
  branch: string | null // the checked-out branch, null when detached
  headHash: string
  remotes: string[]
  localBranches: string[]
  operation?: Operation | null
}

const short = (hash: string) => hash.slice(0, 7)
// git stash apply and pop leave every change unstaged unless told to restore the index.
const STAGED = {
  label: 'Staged changes',
  options: [
    { value: 'unstaged', label: 'Leave all changes unstaged' },
    { value: 'index', label: 'Restore what was staged' },
  ],
}
// Before a name read from the repository: a tag may be called -f, which git would take as an option.
const EOO = '--end-of-options'
const NO_WHITESPACE = '-blank-at-eol,-blank-at-eof,-space-before-tab'

export function groupsFor(c: Commit, ctx: Context): Group[] {
  const current = ctx.branch ?? 'HEAD'
  const remote = ctx.remotes.includes('origin') ? 'origin' : ctx.remotes[0]
  const groups: Group[] = []

  if (c.kind === 'working') {
    groups.push({
      title: 'Uncommitted changes',
      actions: [
        // A stopped merge, cherry-pick, revert or rebase blocks every other action until it ends.
        ...(ctx.operation
          ? [
              {
                id: 'working:continue',
                label: `Continue ${ctx.operation}`,
                // `add -u` would stage a file with its conflict markers still in it; diff --check stops
                // on those (whitespace checks off, so only markers count) before anything is staged.
                run: () => [['-c', `core.whitespace=${NO_WHITESPACE}`, 'diff', '--check', 'HEAD'], ['add', '-u'], [ctx.operation!, '--continue']],
              },
              { id: 'working:abort', label: `Abort ${ctx.operation}`, isDanger: true, run: () => [[ctx.operation!, '--abort']] },
            ]
          : []),
        {
          id: 'working:stash',
          label: 'Stash…',
          input: { label: 'Stash message (optional)', isOptional: true },
          choice: {
            label: 'Include untracked files',
            options: [
              { value: 'yes', label: 'Include untracked files' },
              { value: 'no', label: 'Tracked files only' },
            ],
          },
          run: (msg, untracked) => [['stash', 'push', ...(untracked === 'yes' ? ['-u'] : []), ...(msg ? ['-m', msg] : [])]],
        },
        {
          id: 'working:discard',
          label: 'Discard all changes…',
          isDanger: true,
          choice: {
            label: 'What to discard',
            options: [
              { value: 'tracked', label: 'Changes to tracked files' },
              { value: 'all', label: 'Tracked changes and untracked files' },
            ],
          },
          run: (_, what) => [['reset', '--hard', 'HEAD'], ...(what === 'all' ? [['clean', '-fd']] : [])],
        },
      ],
    })
    return groups
  }

  if (c.kind === 'stash') {
    const name = c.refs[0] ?? c.hash
    groups.push({
      title: `Stash ${name}`,
      actions: [
        { id: 'stash:apply', label: 'Apply…', choice: STAGED, run: (_, i) => [['stash', 'apply', ...(i === 'index' ? ['--index'] : []), name]] },
        { id: 'stash:pop', label: 'Pop…', choice: STAGED, run: (_, i) => [['stash', 'pop', ...(i === 'index' ? ['--index'] : []), name]] },
        {
          id: 'stash:branch',
          label: 'Create branch from stash…',
          input: { label: 'Branch name' },
          run: v => [['stash', 'branch', v, name]],
        },
        { id: 'stash:drop', label: 'Drop', isDanger: true, run: () => [['stash', 'drop', name]] },
        { id: 'stash:copy', label: 'Copy name', copy: name },
      ],
    })
    return groups
  }

  const isMerge = c.parents.length > 1
  const isHead = c.hash === ctx.headHash
  groups.push({
    title: `Commit ${short(c.hash)}`,
    actions: [
      { id: 'commit:checkout', label: 'Check out', run: () => [['checkout', c.hash]] },
      {
        id: 'commit:branch',
        label: 'Create branch…',
        input: { label: 'Branch name' },
        choice: {
          label: 'Then',
          options: [
            { value: 'checkout', label: 'Check it out' },
            { value: 'stay', label: 'Stay on the current branch' },
          ],
        },
        run: (v, then) => [then === 'checkout' ? ['checkout', '-b', v, c.hash] : ['branch', v, c.hash]],
      },
      { id: 'commit:tag', label: 'Add tag…', input: { label: 'Tag name' }, run: v => [['tag', v, c.hash]] },
      ...(isHead
        ? []
        : [
            {
              id: 'commit:cherry-pick',
              label: 'Cherry-pick',
              run: () => [['cherry-pick', ...(isMerge ? ['-m', '1'] : []), c.hash]],
            },
            {
              id: 'commit:merge',
              label: `Merge into ${current}`,
              run: () => [['merge', '--no-edit', c.hash]],
            },
            { id: 'commit:rebase', label: `Rebase ${current} onto this`, run: () => [['rebase', c.hash]] },
          ]),
      { id: 'commit:revert', label: 'Revert', run: () => [['revert', '--no-edit', ...(isMerge ? ['-m', '1'] : []), c.hash]] },
      ...(isHead
        ? []
        : [
            {
              id: 'commit:reset',
              label: `Reset ${current} to here…`,
              isDanger: true,
              choice: {
                label: 'Mode',
                options: [
                  { value: 'mixed', label: 'Mixed: keep changes in the working tree, unstaged' },
                  { value: 'soft', label: 'Soft: keep changes staged' },
                  { value: 'hard', label: 'Hard: discard all changes' },
                ],
              },
              run: (_: string, mode: string) => [['reset', `--${mode}`, c.hash]],
            },
          ]),
      { id: 'commit:copy-hash', label: 'Copy hash', copy: c.hash },
      { id: 'commit:copy-subject', label: 'Copy subject', copy: c.subject },
    ],
  })

  for (const b of badges(c, ctx.remotes, ctx.localBranches)) {
    if (b.kind === 'tag') {
      groups.push({
        title: `Tag ${b.label}`,
        actions: [
          ...(remote ? [{ id: `tag:${b.label}:push`, label: `Push to ${remote}`, run: () => [['push', remote, `refs/tags/${b.label}`]] }] : []),
          { id: `tag:${b.label}:delete`, label: 'Delete', isDanger: true, run: () => [['tag', '-d', EOO, b.label]] },
          { id: `tag:${b.label}:copy`, label: 'Copy name', copy: b.label },
        ],
      })
    } else if (b.kind === 'remote') {
      const slash = b.label.indexOf('/')
      const [rem, name] = [b.label.slice(0, slash), b.label.slice(slash + 1)]
      const hasLocal = ctx.localBranches.includes(name)
      groups.push({
        title: `Remote branch ${b.label}`,
        actions: [
          ...(hasLocal ? [] : [{ id: `remote:${b.label}:checkout`, label: 'Check out as local branch', run: () => [['checkout', '--track', EOO, b.label]] }]),
          { id: `remote:${b.label}:merge`, label: `Merge into ${current}`, run: () => [['merge', '--no-edit', EOO, b.label]] },
          { id: `remote:${b.label}:delete`, label: `Delete on ${rem}`, isDanger: true, run: () => [['push', rem, '--delete', EOO, name]] },
          { id: `remote:${b.label}:copy`, label: 'Copy name', copy: b.label },
        ],
      })
    } else if (b.kind === 'head' || b.kind === 'branch') {
      const name = b.label
      const isCurrent = name === ctx.branch
      // The remote whose twin shares this badge: not always the one pushes go to.
      const twin = ctx.remotes.find(r => c.refs.includes(`${r}/${name}`))
      groups.push({
        title: `Branch ${name}${isCurrent ? ' (checked out)' : ''}`,
        actions: [
          ...(isCurrent
            ? remote
              ? [{ id: `branch:${name}:pull`, label: 'Pull', run: () => [['pull', '--ff-only']] }]
              : []
            : [
                { id: `branch:${name}:checkout`, label: 'Check out', run: () => [['checkout', EOO, name]] },
                { id: `branch:${name}:merge`, label: `Merge into ${current}`, run: () => [['merge', '--no-edit', EOO, name]] },
                { id: `branch:${name}:rebase`, label: `Rebase ${current} onto this`, run: () => [['rebase', EOO, name]] },
              ]),
          ...(remote ? [{ id: `branch:${name}:push`, label: `Push to ${remote}`, run: () => [['push', '-u', remote, EOO, name]] }] : []),
          {
            id: `branch:${name}:rename`,
            label: 'Rename…',
            input: { label: 'New name', value: name },
            run: v => [['branch', '-m', EOO, name, v]],
          },
          ...(isCurrent
            ? []
            : [
                {
                  id: `branch:${name}:delete`,
                  label: 'Delete',
                  isDanger: true,
                  choice: {
                    label: 'Delete',
                    options: [
                      { value: '-d', label: 'Only if merged' },
                      { value: '-D', label: 'Force, even if unmerged' },
                    ],
                  },
                  run: (_: string, flag: string) => [['branch', flag, EOO, name]],
                },
              ]),
          // Its remote twin shares this badge, so its delete lives here.
          ...(twin
            ? [
                {
                  id: `branch:${name}:delete-remote`,
                  label: `Delete on ${twin}`,
                  isDanger: true,
                  run: () => [['push', twin, '--delete', EOO, name]],
                },
              ]
            : []),
          { id: `branch:${name}:copy`, label: 'Copy name', copy: name },
        ],
      })
    }
  }
  return groups
}

// The command line a confirm step shows, quoted where a word needs it.
// --end-of-options is left out: it changes nothing a reader needs to see.
export const describe = (cmds: string[][]) =>
  cmds.map(argv => ['git', ...argv.filter(w => w !== EOO)].map(w => (/^[\w./@{}:=-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(' ')).join(' && ')
