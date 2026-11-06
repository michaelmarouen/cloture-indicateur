import type { ClotureSibling, ClotureVerdict } from '../types'

export type Entry = { id: string; repo: string; label: string; updatedAt: number }

// A live session rewrites its entry every BEAT_MS; a closed one writes updatedAt 0 and is ignored at once.
export const FRESH_MS = 3 * 60_000
export const BEAT_MS = 60_000

export function repoKey(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function parseEntry(text: string): Entry | null {
  try {
    const o = JSON.parse(text)
    if (typeof o.id !== 'string' || typeof o.repo !== 'string' || typeof o.updatedAt !== 'number') return null
    return { id: o.id, repo: o.repo, label: typeof o.label === 'string' ? o.label : '', updatedAt: o.updatedAt }
  } catch {
    return null
  }
}

// Other live sessions on the same repo: fresh entries, not me, one per id (the newest).
export function siblings(entries: readonly Entry[], myId: string, repo: string, now: number): ClotureSibling[] {
  const byId = new Map<string, Entry>()
  for (const e of entries) {
    if (e.id === myId || e.repo !== repo || now - e.updatedAt > FRESH_MS) continue
    const known = byId.get(e.id)
    if (!known || known.updatedAt < e.updatedAt) byId.set(e.id, e)
  }
  return [...byId.values()].map(e => ({ id: e.id, label: e.label }))
}

export function labelFrom(texts: readonly string[]): string {
  const first = texts.find(t => t.trim().length > 0) ?? ''
  const line = first.trim().split('\n')[0] ?? ''
  return line.length > 70 ? `${line.slice(0, 67)}...` : line
}

// A session's name: the repo folder, plus its first line unless that is boilerplate.
export function makeLabel(texts: readonly string[], repo: string): string {
  const name = repo.split('/').filter(Boolean).pop() ?? repo
  const line = labelFrom(texts)
  const isNoise = line === '' || /^(this session is being continued|<)/i.test(line)
  return isNoise ? name : `${name} : ${line}`
}

export function buildSiblingMessage(myLabel: string, v: ClotureVerdict, repo: string): string {
  const facts: string[] = []
  if (v.dirty > 0) facts.push(`${v.dirty} fichier(s) non commité(s)`)
  if (v.worktrees > 0) facts.push(`${v.worktrees} worktree(s) sale(s)`)
  if (v.ahead > 0) facts.push(`${v.ahead} commit(s) non poussé(s)`)
  return [
    `[cloture-indicateur] Une autre session sur le même dépôt${myLabel ? ` (« ${myLabel} »)` : ''} te prévient.`,
    `Dépôt : ${repo}${v.branch ? ` (branche ${v.branch})` : ''}`,
    `État : ${facts.join(', ')}.`,
    'Si certains de ces changements sont les tiens : commit puis push (pathspec explicite, `git diff --cached --stat` avant, jamais --force ni --no-verify). Sinon ignore ce message.',
  ].join('\n')
}

export type SendOutcome = { isDelivered: boolean; reason?: string }

// Sends to each target; a refusal OR a throw is a failure with its reason, never silence.
export async function sendAll(
  targets: readonly ClotureSibling[],
  send: (id: string) => Promise<SendOutcome>,
): Promise<{ delivered: number; failures: string[] }> {
  let delivered = 0
  const failures: string[] = []
  for (const t of targets) {
    try {
      const r = await send(t.id)
      if (r.isDelivered) delivered += 1
      else failures.push(r.reason || 'refusé')
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e))
    }
  }
  return { delivered, failures }
}

export function summarize(total: number, delivered: number, failures: readonly string[]): { ok: boolean; text: string } {
  if (delivered === total) return { ok: true, text: `${delivered}/${total} session(s) prévenue(s)` }
  const why = [...new Set(failures)].slice(0, 2).join(' ; ')
  return { ok: false, text: `${delivered}/${total} session(s) prévenue(s) : ${why}` }
}
