import { expect, test } from 'claude-code/testing'

import { computeVerdict, headline, parseChecker, shouldRefresh, tone } from './git-state'
import type { Run } from './git-state'

function fake(opts: { status?: string; upstream?: boolean; counts?: string; stash?: string }): Run {
  return async argv => {
    const key = argv.slice(1).join(' ')
    const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
    if (key === 'rev-parse --is-inside-work-tree') return ok('true\n')
    if (key.startsWith('status')) return ok(opts.status ?? '')
    if (key === 'rev-parse --abbrev-ref HEAD') return ok('main\n')
    if (key === 'stash list') return ok(opts.stash ?? '')
    if (key === 'rev-parse --abbrev-ref @{u}')
      return opts.upstream === false ? { exitCode: 128, stdout: '', stderr: 'no upstream' } : ok('origin/main\n')
    if (key.startsWith('rev-list')) return ok(opts.counts ?? '0\t0\n')
    return { exitCode: 1, stdout: '', stderr: 'unexpected' }
  }
}

test('PROPRE', async () => {
  expect((await computeVerdict(fake({}))).kind).toBe('PROPRE')
})

test('NON_COMMITE counts entries, rename = one', async () => {
  const v = await computeVerdict(fake({ status: ' M a.txt\0R  new.txt\0old.txt\0?? b.txt\0' }))
  expect(v.kind).toBe('NON_COMMITE')
  expect(v.dirty).toBe(3)
})

test('NON_POUSSE', async () => {
  const v = await computeVerdict(fake({ counts: '0\t2\n' }))
  expect(v.kind).toBe('NON_POUSSE')
  expect(v.ahead).toBe(2)
})

test('SANS_REMOTE', async () => {
  expect((await computeVerdict(fake({ upstream: false }))).kind).toBe('SANS_REMOTE')
})

test('HORS_GIT', async () => {
  const run: Run = async () => ({ exitCode: 128, stdout: '', stderr: 'not a repo' })
  expect((await computeVerdict(run)).kind).toBe('HORS_GIT')
})

test('checker JSON is mapped, garbage is refused', async () => {
  const v = parseChecker('{"kind":"NON_COMMITE","dirty":3,"ahead":0,"stash":1,"branch":"main","worktrees":2}')
  expect(v?.dirty).toBe(3)
  expect(v?.worktrees).toBe(2)
  expect(parseChecker('not json')).toBe(null)
  expect(parseChecker('{"kind":"INVENTE"}')).toBe(null)
  expect(tone(v!)).toBe('stop')
  expect(headline({ kind: 'PROPRE', dirty: 0, ahead: 0, stash: 0, branch: 'main', worktrees: 0 })).toBe('OK POUR FERMER')
})

test('polls every 30s while not green, slowly once green', async () => {
  expect(shouldRefresh('NON_COMMITE', 10_000, false)).toBe(false)
  expect(shouldRefresh('NON_COMMITE', 30_000, false)).toBe(true)
  expect(shouldRefresh('PROPRE', 60_000, false)).toBe(false)
  expect(shouldRefresh('PROPRE', 130_000, false)).toBe(true)
  expect(shouldRefresh('PROPRE', 1_000, true)).toBe(true)
  expect(shouldRefresh(null, 0, false)).toBe(true)
})
