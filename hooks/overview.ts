import type { ClotureOverview, ClotureRepo, ClotureTheme, ClotureTone, ClotureView } from '../types'

const MAX_FILES = 8

// Icon-only buttons keep the pane compact; the active view is named in a dim line beside them.
export const VIEWS: readonly { id: ClotureView; label: string; icon: string }[] = [
  { id: 'depliant', label: 'Dépliant', icon: '▾' },
  { id: 'liste', label: 'Liste', icon: '≡' },
  { id: 'cartes', label: 'Cartes', icon: '▦' },
]

export const THEMES: readonly { id: ClotureTheme; label: string; icon: string }[] = [
  { id: 'auto', label: 'auto', icon: '◐' },
  { id: 'clair', label: 'clair', icon: '☀' },
  { id: 'sombre', label: 'sombre', icon: '☾' },
]

export function nextTheme(t: ClotureTheme): ClotureTheme {
  const i = THEMES.findIndex(x => x.id === t)
  return THEMES[(i + 1) % THEMES.length]!.id
}

export type Palette = { ok: string; stop: string; warn: string; text: string | undefined; bg: string | undefined; card: string | undefined; dim: string | undefined; btn: string | undefined }

// auto: the terminal's own named colours (they follow its theme). clair / sombre: fixed colours with
// enough contrast on a light or a dark background (WCAG AA against white and against #1e1e1e).
export function palette(t: ClotureTheme): Palette {
  if (t === 'clair') return { ok: '#15803d', stop: '#b91c1c', warn: '#a16207', text: '#1f2937', bg: '#ffffff', card: '#f3f4f6', dim: '#6b7280', btn: undefined }
  if (t === 'sombre') return { ok: '#4ade80', stop: '#f87171', warn: '#fbbf24', text: '#e5e7eb', bg: '#1e1e1e', card: '#2a2a2a', dim: '#9ca3af', btn: '#d1d5db' }
  return { ok: 'green', stop: 'red', warn: 'yellow', text: undefined, bg: undefined, card: undefined, dim: undefined, btn: undefined }
}

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
      sessionIds: r.sessions.map(s => s.id ?? '').filter(Boolean),
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

export const AUTO_MS = 30_000
export const STALE_MS = 90_000
export const PANE_LIVE_MS = 30_000
export const READY_MIN_GAP_MS = 60_000

export function ageLabel(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 10) return "à l'instant"
  if (s < 60) return `il y a ${s} s`
  return `il y a ${Math.floor(s / 60)} min`
}

export function isStale(at: number, now: number): boolean {
  return now - at > STALE_MS
}

// Only commits can be pushed from the pane: there must be some, and a remote to receive them.
export function canPush(r: Pick<ClotureRepo, 'ah' | 'upstream'>): boolean {
  return r.ah > 0 && r.upstream
}

export function statusText(a: Answer): string {
  return `cloture: ${a.tone === 'ok' ? '●' : a.tone === 'stop' ? '●' : '◐'} ${a.readyCount}/${a.total} prêts`
}

// A toast only when the whole machine goes from "not yet" to "ready", never on the first read.
export function becameReady(previous: ClotureTone | null, next: ClotureTone): boolean {
  return previous !== null && previous !== 'ok' && next === 'ok'
}

export function defaultView(surface: string): ClotureView {
  return surface === 'mobile' ? 'cartes' : 'depliant'
}
