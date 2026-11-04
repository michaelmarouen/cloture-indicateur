export type ClotureKind = 'PROPRE' | 'NON_COMMITE' | 'NON_POUSSE' | 'SANS_REMOTE' | 'HORS_GIT' | 'ERREUR'

export type ClotureVerdict = {
  kind: ClotureKind
  dirty: number
  ahead: number
  stash: number
  branch: string
  worktrees: number
}

export type ClotureTone = 'ok' | 'stop' | 'warn'

declare module 'claude-code' {
  interface PluginState {
    'cloture-indicateur': { verdict: ClotureVerdict | null; isHidden: boolean }
  }
}
