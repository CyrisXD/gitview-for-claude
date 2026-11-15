export type CommitKind = 'commit' | 'stash' | 'working'

export type Commit = {
  kind: CommitKind
  hash: string // 'WORKING' for the uncommitted changes row
  parents: string[]
  refs: string[]
  author: string
  date: string // ISO 8601
  subject: string
}

export type GraphData = {
  status: 'loading' | 'ok' | 'empty' | 'not-repo' | 'error'
  message: string
  commits: Commit[]
  hasMore: boolean
  remotes: string[]
  branch: string | null // the checked-out branch, null when detached
  headHash: string
  localBranches: string[]
  // Every branch by full ref name (refs/heads/…, refs/remotes/…); absent in values stored before it existed.
  branches?: string[]
  // A merge, cherry-pick, revert or rebase stopped part way (a conflict); absent in values stored before it existed.
  operation?: Operation | null
  remoteCount?: number // remote branches in the repository
  remotesHidden?: boolean // their history is left out of the graph (tracked ones stay)
}

// Remote branches in the graph: auto hides them when there are more than AUTO_HIDE.
export type RemotesMode = 'auto' | 'show' | 'hide'

export type Operation = 'merge' | 'cherry-pick' | 'revert' | 'rebase'

// An action waiting on its confirm step, or running, in the open commit's panel.
export type Pending = {
  id: string
  hash: string
  value: string
  choice: string
  status: 'idle' | 'running' | 'error'
  message: string
}

export type ActionResult = { isOk: boolean; text: string }

// Column widths in cells, set by dragging the dividers in the column heads. graph null: sized to
// its lanes; desc null: fills the room the others leave.
export type Widths = { graph: number | null; desc: number | null; date: number; author: number; commit: number }

// The Refresh button's own feedback: running while it reads, then what it found and when.
export type RefreshState = { status: 'running' } | { status: 'done'; text: string }

export type FileChange = {
  status: string // A, M, D, R, C, T, U, or ? for untracked
  path: string
  oldPath?: string
  added: number | null // null for binary
  removed: number | null
}

export type Details = {
  hash: string
  status: 'loading' | 'ok' | 'error'
  message: string // full commit message, or the error
  author: string
  email: string
  date: string
  parents: string[]
  files: FileChange[]
}

export type FileDiff = {
  hash: string
  path: string
  status: 'loading' | 'ok' | 'error'
  text: string
  isTruncated: boolean
}

export type View = {
  limit: number
  offset: number // the first row drawn
  selected: string | null
  // The window's offset when the row was opened: the window keeps an opened row drawn only until it pages.
  openedAt?: number
  file: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'gitview': {
      data: Shaped<GraphData>
      view: Shaped<View>
      details: Shaped<Details | null>
      diff: Shaped<FileDiff | null>
      pending: Shaped<Pending | null>
      result: Shaped<ActionResult | null>
      refreshing: Shaped<RefreshState | null>
      widths: Shaped<Widths>
      remotes: Shaped<RemotesMode>
      only: Shaped<string | null> // the branch the graph is narrowed to, a full ref name
      filter: Shaped<string> // the search box's text: rows whose subject, author, hash or refs hold it
    }
  }
}
