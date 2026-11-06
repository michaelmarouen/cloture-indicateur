import type { ClotureBase, ClotureVerdict } from '../types'

// First message of a "reprise" session, written by the session that starts it:
//   CLOTURE-BASE: local_<id> | <titre de la session de base> | <titre de cette reprise>
// The two titles are optional.
const MARKER = /CLOTURE-BASE:[ \t]*(local_[A-Za-z0-9_-]+)[ \t]*(?:\|[ \t]*([^|\n]*?)[ \t]*)?(?:\|[ \t]*([^|\n]*?)[ \t]*)?$/m

export function parseBase(texts: readonly string[]): ClotureBase | null {
  for (const text of texts) {
    const m = MARKER.exec(text)
    if (m?.[1]) return { id: m[1], baseTitle: m[2] || '', title: m[3] || '' }
  }
  return null
}

export function canAsk(v: ClotureVerdict | null, base: ClotureBase | null): boolean {
  return base !== null && v !== null && (v.kind === 'NON_COMMITE' || v.kind === 'NON_POUSSE')
}

export function buildMessage(base: ClotureBase, v: ClotureVerdict, cwd: string): string {
  const who = base.title ? `« ${base.title} »` : 'une session de reprise'
  const facts: string[] = []
  if (v.dirty > 0) facts.push(`${v.dirty} fichier(s) non commité(s)`)
  if (v.worktrees > 0) facts.push(`${v.worktrees} worktree(s) sale(s)`)
  if (v.ahead > 0) facts.push(`${v.ahead} commit(s) non poussé(s)`)
  return [
    `[cloture-indicateur] Demande de la session de reprise ${who}.`,
    `Dépôt : ${cwd}${v.branch ? ` (branche ${v.branch})` : ''}`,
    `État : ${facts.join(', ')}.`,
    'Demande : commit puis push de ces changements. Commit par pathspec explicite, `git diff --cached --stat` avant, jamais --force ni --no-verify. Dis-moi quand c\'est fait.',
  ].join('\n')
}
