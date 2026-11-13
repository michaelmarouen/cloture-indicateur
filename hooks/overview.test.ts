import { expect, test } from 'claude-code/testing'

import { answer, counts, defaultView, matrix, parseOverview, ring } from './overview'

const P = (s: string) => s.split('/').join(String.fromCharCode(92))

const raw = JSON.stringify({
  repos: [
    { repo: P('D:/Dev/tradeManager'), verdict: 'PROPRE', blocking: [], generated: [], foreign: [], ahead: 0, upstream: 'origin/main', sessions: [{ id: 'abcdef123', title: 'TM' }], jobs: [] },
    { repo: P('D:/heretic'), verdict: 'NON_COMMITE', blocking: ['pyproject.toml', 'uv.lock'], generated: ['a'], foreign: [], ahead: 1, upstream: 'origin/master', sessions: [{ id: 's1', title: 'heretic : E2E' }], jobs: [] },
    { repo: P('D:/heretic-ui'), verdict: 'PROPRE', blocking: [], generated: [], foreign: ['x'], ahead: 0, upstream: null, sessions: [{ id: 's2', title: '' }], jobs: [] },
    { repo: P('D:/vide'), verdict: 'PROPRE', blocking: [], generated: [], foreign: [], ahead: 0, upstream: 'o', sessions: [], jobs: [] },
    { repo: P('D:/casse'), error: 'boom', sessions: [{ id: 'z' }] },
  ],
  processus_lus: true,
})

test('parseOverview flattens, drops repos without session or in error, sorts stop first', () => {
  const o = parseOverview(raw, 1)
  expect(o?.repos.map(r => r.name)).toEqual(['heretic', 'heretic-ui', 'tradeManager'])
  expect(o?.repos.map(r => r.tone)).toEqual(['stop', 'warn', 'ok'])
  expect(o?.repos[0]).toMatchObject({ nb: 2, gen: 1, ah: 1, files: ['pyproject.toml', 'uv.lock'] })
  expect(o?.repos[1]?.sessions).toEqual(['s2'])
})

test('parseOverview refuses garbage', () => {
  expect(parseOverview('nope', 1)).toBeNull()
  expect(parseOverview('{"x":1}', 1)).toBeNull()
})

test('answer: Non with 3 checks and a next action', () => {
  const a = answer(parseOverview(raw, 1)!)
  expect(a.headline).toBe('Non, pas encore')
  expect(a.tone).toBe('stop')
  expect(a.checks.map(c => c.ok)).toEqual([false, false, true])
  expect(a.checks[0]?.text).toBe('2 fichiers à sauver dans 1 dépôt')
  expect(a.next).toBe('heretic : 2 fichiers à commiter ou écarter, dont pyproject.toml.')
  expect([a.readyCount, a.total, a.generated]).toEqual([1, 3, 1])
})

test('answer: Oui when everything is clean', () => {
  const clean = JSON.stringify({ repos: [{ repo: P('D:/a'), blocking: [], generated: [], foreign: [], ahead: 0, upstream: 'o', sessions: [{ id: 'i', title: 't' }], jobs: [] }], processus_lus: true })
  const a = answer(parseOverview(clean, 1)!)
  expect(a.headline).toBe('Oui, tu peux fermer')
  expect(a.next).toBe('Tu peux fermer toutes les sessions.')
  expect(a.checks.every(c => c.ok)).toBe(true)
})

test('unread jobs are never reported as none', () => {
  const o = parseOverview(JSON.stringify({ repos: [{ repo: P('D:/a'), blocking: [], ahead: 0, upstream: 'o', sessions: [{ id: 'i' }] }] }), 1)!
  expect(answer(o).checks[2]).toEqual({ ok: false, text: 'Jobs lourds non lus' })
})

test('ring, counts, matrix and default view', () => {
  expect(ring(2, 6)).toBe('███░░░░░░░ 2/6')
  expect(ring(0, 0)).toBe('░░░░░░░░░░ 0/0')
  const o = parseOverview(raw, 1)!
  expect(counts(o.repos[0]!)).toBe('2 à sauver · 1 à pousser')
  expect(counts(o.repos[1]!)).toBe('aucun distant')
  expect(counts(o.repos[2]!)).toBe('propre et poussé')
  const m = matrix(o.repos)
  expect(m).toHaveLength(4)
  expect(m[0]).toContain('Sauver')
  expect(m[1]).toMatch(/^heretic\s+2\s+1\s+1\s+0\s+1$/)
  expect(defaultView('mobile')).toBe('cartes')
  expect(defaultView('desktop')).toBe('depliant')
})
