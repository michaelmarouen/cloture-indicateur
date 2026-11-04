import type { ClotureVerdict } from '../types'

export type Run = (
  argv: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

// Porcelain v1 -z : "XY path\0", a rename or copy adds one "origin\0" entry.
export function countEntries(stdout: string): number {
  const tokens = stdout.split('\0').filter(t => t.length > 0)
  let count = 0
  for (let i = 0; i < tokens.length; i++) {
    count += 1
    const code = tokens[i]?.[0]
    if (code === 'R' || code === 'C') i += 1
  }
  return count
}

export async function computeVerdict(run: Run): Promise<ClotureVerdict> {
  const empty = { dirty: 0, ahead: 0, stash: 0, branch: '' }
  try {
    const inside = await run(['git', 'rev-parse', '--is-inside-work-tree'])
    if (inside.exitCode !== 0) return { kind: 'HORS_GIT', ...empty }

    const status = await run(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=normal'])
    if (status.exitCode !== 0) return { kind: 'ERREUR', ...empty }
    const dirty = countEntries(status.stdout)

    const branch = (await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
    const stash = (await run(['git', 'stash', 'list'])).stdout.split('\n').filter(Boolean).length

    const upstream = await run(['git', 'rev-parse', '--abbrev-ref', '@{u}'])
    let ahead = 0
    let hasUpstream = upstream.exitCode === 0
    if (hasUpstream) {
      const counts = await run(['git', 'rev-list', '--left-right', '--count', '@{u}...HEAD'])
      const parts = counts.stdout.trim().split(/\s+/)
      ahead = counts.exitCode === 0 ? Number(parts[1]) || 0 : 0
    }

    const base = { dirty, ahead, stash, branch }
    if (dirty > 0) return { kind: 'NON_COMMITE', ...base }
    if (!hasUpstream) return { kind: 'SANS_REMOTE', ...base }
    if (ahead > 0) return { kind: 'NON_POUSSE', ...base }
    return { kind: 'PROPRE', ...base }
  } catch {
    return { kind: 'ERREUR', ...empty }
  }
}

export function describe(v: ClotureVerdict): string {
  const facts: string[] = []
  if (v.dirty > 0) facts.push(`${v.dirty} non commite(s)`)
  if (v.ahead > 0) facts.push(`${v.ahead} non pousse(s)`)
  if (v.kind === 'SANS_REMOTE') facts.push('sans remote/amont')
  if (v.stash > 0) facts.push(`${v.stash} stash`)
  switch (v.kind) {
    case 'PROPRE':
      return v.stash > 0
        ? `OK POUR FERMER (depot propre, ${v.stash} stash a verifier)`
        : 'OK POUR FERMER (depot propre et pousse)'
    case 'HORS_GIT':
      return 'OK POUR FERMER cote git (dossier hors depot : rien a pousser)'
    case 'ERREUR':
      return 'NE PAS FERMER : etat git illisible'
    default:
      return `NE PAS FERMER : ${facts.join(', ')}`
  }
}
