/** One mod, slimmed from the catalogue's record. */
export type Mod = {
  id: string
  name: string
  repo: string
  description: string
  author: string
  url: string
  stars: number
  createdAt: string
  /** 0 draws and remembers, 1 reads, 2 writes or runs, 3 network */
  level: number
  levelName: string
  labels: string[]
  sees: string[]
  draws: string[]
  validate: string
  /** The marketplace name to install from, when the repo root has one. */
  marketplace: string | null
}

export type Sort = 'stars' | 'new' | 'name'
export type Filter = 'all' | 'installable' | 'safe' | 'pane' | 'band'

declare module 'claude-code' {
  interface PluginState {
    'mod-store': {
      query: string
      sort: Sort
      filter: Filter
      page: number
      selected: string | null
      isConfirming: boolean
      isBusy: boolean
      status: string
      loadedAt: number
      installed: string[]
    }
  }
}
