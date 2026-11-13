import { expect, test } from 'claude-code/testing'

import { checkerScript, computeVerdict, extras, headline, parseChecker, reason, shouldRefresh, tone } from './git-state'
import type { Run } from './git-state'
import { buildMessage, canAsk, parseBase } from './base'
import { FRESH_MS, buildSiblingMessage, labelFrom, makeLabel, parseEntry, repoKey, sendAll, siblings, summarize, classifyNotice, modeMismatch } from './registry'

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
  expect(headline({ kind: 'PROPRE', dirty: 0, ahead: 0, stash: 0, branch: 'main', worktrees: 0 })).toBe('Oui, tu peux fermer')
})

test('polls every 30s while not green, slowly once green', async () => {
  expect(shouldRefresh('NON_COMMITE', 10_000, false)).toBe(false)
  expect(shouldRefresh('NON_COMMITE', 30_000, false)).toBe(true)
  expect(shouldRefresh('PROPRE', 60_000, false)).toBe(false)
  expect(shouldRefresh('PROPRE', 130_000, false)).toBe(true)
  expect(shouldRefresh('PROPRE', 1_000, true)).toBe(true)
  expect(shouldRefresh(null, 0, false)).toBe(true)
})

const DIRTY = { kind: 'NON_COMMITE', dirty: 3, ahead: 0, stash: 0, branch: 'main', worktrees: 0 } as const

test('base marker is read from the first messages', async () => {
  const b = parseBase(['bonjour', 'CLOTURE-BASE: local_44edfc59-2914 | Fichier Python 2700 Mo de Windows | Reprise : mod indicateur de cloture'])
  expect(b?.id).toBe('local_44edfc59-2914')
  expect(b?.baseTitle).toBe('Fichier Python 2700 Mo de Windows')
  expect(b?.title).toBe('Reprise : mod indicateur de cloture')
  expect(parseBase(['CLOTURE-BASE: local_abc'])?.baseTitle).toBe('')
  expect(parseBase(['pas de marqueur'])).toBe(null)
})

test('button only when the repo has work to save and a base is known', async () => {
  const base = { id: 'local_x', baseTitle: '', title: '' }
  expect(canAsk(DIRTY, base)).toBe(true)
  expect(canAsk(DIRTY, null)).toBe(false)
  expect(canAsk({ ...DIRTY, kind: 'PROPRE', dirty: 0 }, base)).toBe(false)
  expect(canAsk({ ...DIRTY, kind: 'HORS_GIT', dirty: 0 }, base)).toBe(false)
})

test('the message names the reprise, the repo and the ask', async () => {
  const m = buildMessage({ id: 'local_x', baseTitle: 'B', title: 'Reprise : mod indicateur de cloture' }, DIRTY, 'D:/Dev/perso/x')
  expect(m).toContain('Reprise : mod indicateur de cloture')
  expect(m).toContain('D:/Dev/perso/x (branche main)')
  expect(m).toContain('3 fichier(s) non commité(s)')
  expect(m).toContain('commit puis push')
})

const T0 = 1_000_000_000

test('siblings: same repo, fresh, not me', async () => {
  const E = (id: string, repo: string, ageMs: number) => ({ id, repo, label: id, updatedAt: T0 - ageMs })
  const out = siblings([E('me', 'r', 0), E('a', 'r', 1000), E('old', 'r', FRESH_MS + 1), E('other', 'x', 0), E('a', 'r', 5)], 'me', 'r', T0)
  expect(out.map(s => s.id)).toEqual(['a'])
})

test('registry helpers', async () => {
  expect(repoKey('D:\\Dev\\Perso\\X\n')).toBe('d:/dev/perso/x')
  expect(parseEntry('nope')).toBe(null)
  expect(parseEntry('{"id":"a","repo":"r","updatedAt":5}')?.label).toBe('')
  expect(labelFrom(['', 'Reprise : mod\nsuite'])).toBe('Reprise : mod')
  expect(buildSiblingMessage('R', DIRTY, 'd:/x')).toContain('3 fichier(s) non commité(s)')
})

test('label: repo name, snippet only when meaningful', async () => {
  expect(makeLabel(['This session is being continued from a previous conversation'], 'd:/dev/perso/chifoumi')).toBe('chifoumi')
  expect(makeLabel(['Reprise : mod'], 'd:/dev/perso/x')).toBe('x : Reprise : mod')
})

test('after a request, polls every 5s until clean', async () => {
  expect(shouldRefresh('NON_COMMITE', 5_000, false, true)).toBe(true)
  expect(shouldRefresh('NON_COMMITE', 4_000, false, true)).toBe(false)
  expect(shouldRefresh('PROPRE', 4_000, false, true)).toBe(false)
})

test('checker script path has no backslash to swallow', async () => {
  expect(checkerScript('C:\\Users\\mic')).toBe('C:/Users/mic/.claude/scripts/cloture_check.py')
})

test('a refused or thrown send is reported with its reason, never silent', async () => {
  const targets = [{ id: 'a', label: '', mode: '' }, { id: 'b', label: '', mode: '' }, { id: 'c', label: '', mode: '' }]
  const out = await sendAll(targets, async id => {
    if (id === 'a') return { isDelivered: true }
    if (id === 'b') return { isDelivered: false, reason: 'recipient gone' }
    throw new Error('socket closed')
  })
  expect(out.delivered).toBe(1)
  expect(out.failures).toEqual(['recipient gone', 'socket closed'])
  expect(summarize(3, 1, out.failures).ok).toBe(false)
  expect(summarize(3, 1, out.failures).text).toContain('recipient gone')
  expect(summarize(2, 2, []).ok).toBe(true)
})

test('a send the classifier gave no verdict on is retried once, not twice', async () => {
  const noVerdict = { isDelivered: false, reason: 'The server-side auto mode classifier gave no verdict for SendMessage' }
  let calls = 0
  const ok = await sendAll([{ id: 'a', label: '', mode: '' }], async () => (++calls === 1 ? noVerdict : { isDelivered: true }))
  expect(ok.delivered).toBe(1)
  expect(calls).toBe(2)
  calls = 0
  const ko = await sendAll([{ id: 'a', label: '', mode: '' }], async () => (++calls, noVerdict))
  expect(ko.delivered).toBe(0)
  expect(calls).toBe(2)
})

test('a closed session (updatedAt 0) is not a sibling', async () => {
  expect(siblings([{ id: 'x', repo: '', label: '', updatedAt: 0 }, { id: 'y', repo: 'r', label: '', updatedAt: 0 }], 'me', 'r', T0)).toEqual([])
})

test('engine delivery notices are understood', async () => {
  const held = classifyNotice('[Cross-session delivery notice] 1 message was held by that session. NOT delivered: its Claude has not seen it.')
  expect(held?.ok).toBe(false)
  expect(held?.isFinal).toBe(false)
  expect(classifyNotice('[Cross-session delivery notice] it was approved and released to that session.')?.ok).toBe(true)
  expect(classifyNotice('[Cross-session delivery notice] denied by the recipient user. Not delivered')?.isFinal).toBe(true)
  expect(classifyNotice('[Cross-session delivery notice] not approved before expiry. Not delivered to that session')?.text).toContain('expiré')
  expect(classifyNotice('un message quelconque')).toBe(null)
})

test('permission modes that differ are flagged, unknown ones are not', async () => {
  const o = [{ id: 'a', label: '', mode: 'default' }, { id: 'b', label: '', mode: 'acceptEdits' }, { id: 'c', label: '', mode: '' }]
  expect(modeMismatch('default', o).map(s => s.id)).toEqual(['b'])
  expect(modeMismatch('', o)).toEqual([])
})

test('extras: les fichiers régénérés et hors session sont affichés, jamais bloquants', () => {
  const v = parseChecker(JSON.stringify({ kind: 'PROPRE', dirty: 0, generated: 4, foreign: 1, branch: 'main' }))!
  expect(extras(v)).toBe('(+ 4 régénéré(s), 1 hors session, non bloquant)')
  expect(reason(v)).toContain('dépôt propre et poussé')
  expect(reason(v)).toContain('non bloquant')
  expect(tone(v)).toBe('ok')
})

test('extras: rien à afficher sans generated ni foreign', () => {
  const v = parseChecker(JSON.stringify({ kind: 'PROPRE', dirty: 0, branch: 'main' }))!
  expect(extras(v)).toBe('')
  expect(reason(v)).toBe('dépôt propre et poussé')
})
