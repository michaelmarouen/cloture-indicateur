import type { ClotureOverview, ClotureRepo, ClotureTone, ClotureView } from '../types'

const MAX_FILES = 8

export const VIEWS: readonly { id: ClotureView; label: string }[] = [
  { id: 'depliant', label: 'Dépliant' },
  { id: 'liste', label: 'Liste' },
  { id: 'cartes', label: 'Cartes' },
  { id: 'matrice', label: 'Matrice' },
]

type Raw = {
  repos?: {
    repo: string
    verdict?: string
    blocking?: string[]
    generated?: string[]
    foreign?: string[]
    ahead?: number
    upstream?: unknown
    sessions?: { id?: string; title?: string }[]
    jobs?: unknown[]
    error?: unknown
  }[]
  sessions_hors_git?: unknown[]
  processus_lus?: unknown
}

function repoTone(r: Pick<ClotureRepo, 'nb' | 'ah' | 'upstream'>): ClotureTone {
  if (r.nb > 0) return 'stop'
  return r.ah > 0 || !r.upstream ? 'warn' : 'ok'
}

// Output of `cloture_check.py --sessions FILE --json`, flattened like the Angela /cloture page does.
export function parseOverview(stdout: string, now: number): ClotureOverview | null {
  let raw: Raw
  try {
    raw = JSON.parse(stdout) as Raw
  } catch {
    return null
  }
  if (!raw || !Array.isArray(raw.repos)) return null
  const repos: ClotureRepo[] = []
  for (const r of raw.repos) {
    if (r.error || !r.sessions || r.sessions.length === 0) continue
    const item = {
      name: r.repo.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? r.repo,
      path: r.repo,
      nb: (r.blocking ?? []).length,
      gen: (r.generated ?? []).length,
      fo: (r.foreign ?? []).length,
      ah: Number(r.ahead) || 0,
      ns: r.sessions.length,
      jobs: (r.jobs ?? []).length,
      upstream: Boolean(r.upstream),
      files: (r.blocking ?? []).slice(0, MAX_FILES),
      sessions: r.sessions.map(s => s.title || (s.id ?? '').slice(0, 8)),
    }
    repos.push({ ...item, tone: repoTone(item) })
  }
  const order = { stop: 0, warn: 1, ok: 2 } as const
  repos.sort((a, b) => order[a.tone] - order[b.tone] || b.nb - a.nb || a.name.localeCompare(b.name))
  return { at: now, repos, jobsRead: Boolean(raw.processus_lus) }
}

export type Answer = {
  tone: ClotureTone
  headline: string
  detail: string
  readyCount: number
  total: number
  checks: { ok: boolean; text: string }[]
  next: string
  generated: number
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`

export function answer(o: ClotureOverview): Answer {
  const stop = o.repos.filter(r => r.tone === 'stop')
  const warn = o.repos.filter(r => r.tone === 'warn')
  const ok = o.repos.filter(r => r.tone === 'ok')
  const files = stop.reduce((n, r) => n + r.nb, 0)
  const ahead = o.repos.reduce((n, r) => n + r.ah, 0)
  const jobs = o.repos.reduce((n, r) => n + r.jobs, 0)
  const sessions = o.repos.reduce((n, r) => n + r.ns, 0)
  const tone: ClotureTone = stop.length > 0 ? 'stop' : warn.length > 0 ? 'warn' : 'ok'
  const first = stop[0] ?? warn[0]
  let next = 'Tu peux fermer toutes les sessions.'
  if (first && first.tone === 'stop') {
    next = `${first.name} : ${plural(first.nb, 'fichier', 'fichiers')} à commiter ou écarter${first.files[0] ? `, dont ${first.files[0]}` : ''}.`
  } else if (first) {
    next = first.ah > 0 ? `${first.name} : ${plural(first.ah, 'commit', 'commits')} à pousser.` : `${first.name} : aucun distant, rien n'est sauvegardé en ligne.`
  }
  return {
    tone,
    headline: tone === 'ok' ? 'Oui, tu peux fermer' : 'Non, pas encore',
    detail: `${plural(stop.length, 'dépôt avec du travail à sauver', 'dépôts avec du travail à sauver')}, ${warn.length} à surveiller, ${ok.length} prêt(s). ${plural(sessions, 'session concernée', 'sessions concernées')}.`,
    readyCount: ok.length,
    total: o.repos.length,
    checks: [
      { ok: files === 0, text: files === 0 ? 'Aucun fichier à sauver' : `${plural(files, 'fichier', 'fichiers')} à sauver dans ${plural(stop.length, 'dépôt', 'dépôts')}` },
      { ok: ahead === 0, text: ahead === 0 ? 'Aucun commit à pousser' : `${plural(ahead, 'commit', 'commits')} pas encore poussé(s)` },
      o.jobsRead
        ? { ok: jobs === 0, text: jobs === 0 ? 'Aucun job lourd en cours' : `${plural(jobs, 'job lourd', 'jobs lourds')} en cours` }
        : { ok: false, text: 'Jobs lourds non lus' },
    ],
    next,
    generated: o.repos.reduce((n, r) => n + r.gen, 0),
  }
}

export function ring(ready: number, total: number, width = 10): string {
  const filled = total > 0 ? Math.round((ready / total) * width) : 0
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${ready}/${total}`
}

export function counts(r: ClotureRepo): string {
  const bits: string[] = []
  if (r.nb > 0) bits.push(`${r.nb} à sauver`)
  if (r.ah > 0) bits.push(`${r.ah} à pousser`)
  if (!r.upstream) bits.push('aucun distant')
  if (bits.length === 0) bits.push('propre et poussé')
  return bits.join(' · ')
}

export function matrix(repos: readonly ClotureRepo[]): string[] {
  const head = ['Dépôt', 'Sauver', 'Pousser', 'Régén.', 'Hors', 'Sess.']
  const rows = repos.map(r => [r.name, String(r.nb), String(r.ah), String(r.gen), String(r.fo), String(r.ns)])
  const w = head.map((h, i) => Math.max(h.length, ...rows.map(row => (row[i] ?? '').length)))
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(w[i] ?? 0) : c.padStart(w[i] ?? 0))).join('  ')
  return [line(head), ...rows.map(line)]
}

export function defaultView(surface: string): ClotureView {
  return surface === 'mobile' ? 'cartes' : 'depliant'
}
