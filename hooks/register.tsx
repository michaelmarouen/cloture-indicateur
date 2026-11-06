import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ClotureBase, ClotureSibling, ClotureVerdict } from '../types'
import { buildMessage, canAsk, parseBase } from './base'
import { buildSiblingMessage, makeLabel, parseEntry, repoKey, siblings } from './registry'
import { TICK_MS, WAIT_MAX_MS, checkerScript, computeVerdict, describe, headline, parseChecker, reason, shouldRefresh, tone } from './git-state'

const verdict = atom({ plugin: 'cloture-indicateur', key: 'verdict' } as const, null)
const isHidden = atom({ plugin: 'cloture-indicateur', key: 'isHidden' } as const, false)
const baseAtom = atom({ plugin: 'cloture-indicateur', key: 'base' } as const, null)
const siblingsAtom = atom({ plugin: 'cloture-indicateur', key: 'siblings' } as const, [])
const isSiblingsSent = atom({ plugin: 'cloture-indicateur', key: 'isSiblingsSent' } as const, false)
const isWaiting = atom({ plugin: 'cloture-indicateur', key: 'isWaiting' } as const, false)
const isSent = atom({ plugin: 'cloture-indicateur', key: 'isSent' } as const, false)

// A turn can only change the repo through these; anything else skips the recompute.
const WRITERS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const COLORS = { ok: 'green', stop: 'red', warn: 'yellow' } as const

let waitingSince = 0
let myLabel = ''
let lastAt = 0
let isBusy = false
let isDirty = true

// Optional single source of truth: ~/.claude/scripts/cloture_check.py --git-only.
// Absent or failing, the built-in git logic answers.
async function viaChecker($: EngineInterface, cwd: string): Promise<ClotureVerdict | null> {
  const home = await $.env.get('USERPROFILE')
  if (!home) return null
  const script = checkerScript(home)
  try {
    const r = await $.process.run(['python', '-I', script, '--git-only', cwd], { timeoutMs: 15000 })
    return r.exitCode === 0 ? parseChecker(r.stdout) : null
  } catch {
    return null
  }
}

// After a request goes out, poll fast until the repo is clean (or WAIT_MAX_MS passes).
async function startWaiting($: EngineInterface) {
  waitingSince = await $.clock.now()
  isDirty = true
  await update($, isWaiting, () => true)
}

async function stopWaiting($: EngineInterface) {
  waitingSince = 0
  await update($, isWaiting, () => false)
}

// The base session's id comes from the marker in this session's first messages.
async function findBase($: EngineInterface) {
  if ((await read($, baseAtom)) !== null) return
  const texts = (await $.session.messages()).filter(m => m.role === 'user').slice(0, 3).map(m => m.text)
  const found = parseBase(texts)
  if (found) await update($, baseAtom, () => found)
}

async function askBase($: EngineInterface, base: ClotureBase, v: ClotureVerdict) {
  const text = buildMessage(base, v, await $.session.cwd())
  let sent = await $.session.send({ to: { sessionId: base.id }, text })
  if (!sent.isDelivered) sent = await $.session.send({ to: base.id, text })
  if (sent.isDelivered) {
    await update($, isSent, () => true)
    await startWaiting($)
    $.ui.toast(`Message envoyé à la session de base${base.baseTitle ? ` « ${base.baseTitle} »` : ''}`)
  } else {
    $.ui.toast(`Envoi impossible : ${sent.reason}`)
  }
}

// Registry: one small file per live session, so a session finds the others on its repo.
async function registryDir($: EngineInterface): Promise<string | null> {
  const home = await $.env.get('USERPROFILE')
  return home ? `${home}/.claude/cloture-registry` : null
}

async function syncRegistry($: EngineInterface, v: ClotureVerdict) {
  const dir = await registryDir($)
  if (!dir || v.kind === 'HORS_GIT' || v.kind === 'ERREUR') {
    await update($, siblingsAtom, () => [])
    return
  }
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
  const repo = repoKey(top.stdout)
  if (top.exitCode !== 0 || !repo) return
  const id = await $.session.id()
  const now = await $.clock.now()
  if (!myLabel) {
    myLabel = makeLabel((await $.session.messages()).filter(m => m.role === 'user').map(m => m.text), repo)
  }
  await $.fs.write(`${dir}/${id}.json`, JSON.stringify({ id, repo, label: myLabel, updatedAt: now }))
  const entries = []
  for (const f of await $.fs.list(dir)) {
    if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
    const entry = parseEntry(String(await $.fs.read(`${dir}/${f.name}`)))
    if (entry) entries.push(entry)
  }
  const others = siblings(entries, id, repo, now)
  await update($, siblingsAtom, () => others)
  if (others.length === 0) await update($, isSiblingsSent, () => false)
}

async function warnSiblings($: EngineInterface, others: ClotureSibling[], v: ClotureVerdict) {
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
  const text = buildSiblingMessage(myLabel, v, top.stdout.trim() || (await $.session.cwd()))
  let delivered = 0
  for (const s of others) {
    const sent = await $.session.send({ to: { sessionId: s.id }, text })
    if (sent.isDelivered) delivered += 1
  }
  if (delivered > 0) {
    await update($, isSiblingsSent, () => true)
    await startWaiting($)
  }
  $.ui.toast(`${delivered}/${others.length} session(s) prévenue(s)`)
}

async function refresh($: EngineInterface) {
  if (isBusy) return
  isBusy = true
  try {
    const cwd = await $.session.cwd()
    const previous = (await read($, verdict)) as ClotureVerdict | null
    const next =
      (await viaChecker($, cwd)) ?? (await computeVerdict(argv => $.process.run(argv, { timeoutMs: 10000 })))
    lastAt = await $.clock.now()
    await syncRegistry($, next)
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return
    await update($, verdict, () => next)
    if (next.kind === 'PROPRE') {
      await update($, isSent, () => false)
      await update($, isSiblingsSent, () => false)
      if (waitingSince > 0) {
        await stopWaiting($)
        $.ui.toast('Tout est commité et poussé : tu peux fermer cette session')
      }
    }
    if (previous?.kind !== next.kind) await update($, isHidden, () => false)
    $.ui.status(`cloture: ${describe(next)}`)
    if (previous && previous.kind !== 'PROPRE' && next.kind === 'PROPRE') {
      $.ui.toast('Depot propre : tu peux fermer cette session')
    }
  } finally {
    isBusy = false
  }
}

async function tick($: EngineInterface) {
  await findBase($)
  const v = (await read($, verdict)) as ClotureVerdict | null
  const now = await $.clock.now()
  if (waitingSince > 0 && now - waitingSince > WAIT_MAX_MS) await stopWaiting($)
  const age = now - lastAt
  if (!isBusy && shouldRefresh(v?.kind ?? null, age, isDirty, waitingSince > 0)) {
    isDirty = false
    await refresh($)
  }
}

export const register: Register = on => {
  on('session.start', ($, e, next) => {
    $.clock.after(0, () => void refresh($))
    $.clock.every(TICK_MS, () => void tick($))
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    if (WRITERS.has(String(e.tool)) || String(e.tool).startsWith('mcp__')) isDirty = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    $.clock.after(0, () => void tick($))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = (await read($, verdict)) as ClotureVerdict | null
    if (e.props.hasSurvey || v === null || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const t = tone(v)
    const color = COLORS[t]
    const base = (await read($, baseAtom)) as ClotureBase | null
    const sent = await read($, isSent)
    const isAskable = canAsk(v, base)
    const others = (await read($, siblingsAtom)) as ClotureSibling[]
    const sentSiblings = await read($, isSiblingsSent)
    const isWarnable = t === 'stop' && others.length > 0
    const waiting = await read($, isWaiting)

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        <Box gap={2} flexWrap="wrap">
          <Text color={color} bold>
            ● {headline(v)}
          </Text>
          <Text dimColor>{v.branch ? `branche ${v.branch}` : 'hors dépôt'}</Text>
        </Box>
        <Text>{reason(v)}</Text>
        {t === 'stop' ? (
          <Text dimColor>Verdict par dépôt : une autre session du même dépôt compte aussi.</Text>
        ) : null}
        {waiting && t === 'stop' ? (
          <Text color="yellow">⏳ Demande envoyée : j'attends que les autres sessions commitent et poussent (vérifié toutes les 5 s).</Text>
        ) : null}
        {isWarnable ? (
          <Text dimColor>
            Autres sessions sur ce dépôt : {others.map(o => o.label || o.id.slice(0, 8)).slice(0, 3).join(', ')}
            {others.length > 3 ? ` (+${others.length - 3})` : ''}
          </Text>
        ) : null}
        <Box gap={2} flexWrap="wrap">
          {isWarnable ? (
            <Button
              key="warn"
              variant={isAskable ? 'secondary' : 'primary'}
              label={`${sentSiblings ? 'Reprévenir' : 'Prévenir'} les ${others.length} autre(s) session(s) du dépôt`}
              onPress={() => warnSiblings($, others, v)}
            />
          ) : null}
          {isAskable && base ? (
            <Button
              key="ask"
              variant="primary"
              label={sent ? 'Renvoyer la demande à la base' : 'Demander commit + push à la base'}
              onPress={() => askBase($, base, v)}
            />
          ) : null}
          <Button key="hide" label="Masquer" onPress={() => update($, isHidden, () => true)} />
        </Box>
      </Box>
    )
  })
}
