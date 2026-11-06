import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ClotureBase, ClotureVerdict } from '../types'
import { buildMessage, canAsk, parseBase } from './base'
import { POLL_MS, computeVerdict, describe, headline, parseChecker, reason, shouldRefresh, tone } from './git-state'

const verdict = atom({ plugin: 'cloture-indicateur', key: 'verdict' } as const, null)
const isHidden = atom({ plugin: 'cloture-indicateur', key: 'isHidden' } as const, false)
const baseAtom = atom({ plugin: 'cloture-indicateur', key: 'base' } as const, null)
const isSent = atom({ plugin: 'cloture-indicateur', key: 'isSent' } as const, false)

// A turn can only change the repo through these; anything else skips the recompute.
const WRITERS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const COLORS = { ok: 'green', stop: 'red', warn: 'yellow' } as const

let lastAt = 0
let isBusy = false
let isDirty = true

// Optional single source of truth: ~/.claude/scripts/cloture_check.py --git-only.
// Absent or failing, the built-in git logic answers.
async function viaChecker($: EngineInterface, cwd: string): Promise<ClotureVerdict | null> {
  const home = await $.env.get('USERPROFILE')
  if (!home) return null
  const script = `${home}\.claude\scripts\cloture_check.py`
  try {
    const r = await $.process.run(['python', '-I', script, '--git-only', cwd], { timeoutMs: 15000 })
    return r.exitCode === 0 ? parseChecker(r.stdout) : null
  } catch {
    return null
  }
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
    $.ui.toast(`Message envoye a la session de base${base.baseTitle ? ` « ${base.baseTitle} »` : ''}`)
  } else {
    $.ui.toast(`Envoi impossible : ${sent.reason}`)
  }
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
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return
    await update($, verdict, () => next)
    if (next.kind === 'PROPRE') await update($, isSent, () => false)
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
  const age = (await $.clock.now()) - lastAt
  if (!isBusy && shouldRefresh(v?.kind ?? null, age, isDirty)) {
    isDirty = false
    await refresh($)
  }
}

export const register: Register = on => {
  on('session.start', ($, e, next) => {
    $.clock.after(0, () => void refresh($))
    $.clock.every(POLL_MS, () => void tick($))
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
    const color = COLORS[tone(v)]
    const base = (await read($, baseAtom)) as ClotureBase | null
    const sent = await read($, isSent)
    const isAskable = canAsk(v, base)

    return (
      <Box>
        <Text color={color} bold>
          ● {headline(v)}{' '}
        </Text>
        <Text>
          {reason(v)} [{v.branch || 'hors depot'}]{' '}
        </Text>
        <Text dimColor>(verdict par depot, autres sessions possibles) </Text>
        {isAskable && base ? (
          <Button
            key="ask"
            label={sent ? 'Renvoyer a la base' : 'Demander commit+push a la base'}
            onPress={() => askBase($, base, v)}
          />
        ) : null}{' '}
        <Button key="hide" label="Masquer" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
