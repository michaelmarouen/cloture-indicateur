export type ClotureKind = 'PROPRE' | 'NON_COMMITE' | 'NON_POUSSE' | 'SANS_REMOTE' | 'HORS_GIT' | 'ERREUR'

export type ClotureVerdict = {
  kind: ClotureKind
  dirty: number
  ahead: number
  stash: number
  branch: string
  worktrees: number
  generated?: number
  foreign?: number
}

export type ClotureBase = { id: string; baseTitle: string; title: string }

export type ClotureSibling = { id: string; label: string; mode: string }

export type ClotureNote = { ok: boolean; text: string }

export type ClotureTone = 'ok' | 'stop' | 'warn'

export type ClotureView = 'depliant' | 'liste' | 'cartes'

export type ClotureTheme = 'auto' | 'clair' | 'sombre'

export type ClotureRepo = {
  name: string
  path: string
  tone: ClotureTone
  nb: number
  gen: number
  fo: number
  ah: number
  ns: number
  jobs: number
  upstream: boolean
  files: string[]
  sessions: string[]
}

export type ClotureOverview = { at: number; repos: ClotureRepo[]; jobsRead: boolean }

declare module 'claude-code' {
  interface PluginState {
    'cloture-indicateur': { verdict: ClotureVerdict | null; isHidden: boolean; base: ClotureBase | null; isSent: boolean; siblings: ClotureSibling[]; isSiblingsSent: boolean; isWaiting: boolean; sendNote: ClotureNote | null; overview: ClotureOverview | null; view: ClotureView | null; theme: ClotureTheme; isOverviewBusy: boolean; isArmed: boolean; overviewNote: ClotureNote | null }
  }
}
