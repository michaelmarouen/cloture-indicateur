import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ClotureVerdict } from '../types'
import { computeVerdict, describe, headline, parseChecker, reason, tone } from './git-state'

const verdict = atom({ plugin: 'cloture-indicateur', key: 'verdict' } as const, null)
const isHidden = atom({ plugin: 'cloture-indicateur', key: 'isHidden' } as const, false)

// A turn can only change the repo through these; anything else skips the recompute.
const WRITERS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MAX_AGE_MS = 120_000
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
    $.ui.status(`cloture: ${describe(next)}`)
    if (previous && previous.kind !== 'PROPRE' && next.kind === 'PROPRE') {
      $.ui.toast('Depot propre : tu peux fermer cette session')
    }
  } finally {
    isBusy = false
  }
}

export const register: Register = on => {
  on('session.start', ($, e, next) => {
    $.clock.after(0, () => void refresh($))
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    if (WRITERS.has(String(e.tool)) || String(e.tool).startsWith('mcp__')) isDirty = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const age = (await $.clock.now()) - lastAt
    if (isDirty || age > MAX_AGE_MS) {
      isDirty = false
      $.clock.after(0, () => void refresh($))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = (await read($, verdict)) as ClotureVerdict | null
    if (e.props.hasSurvey || v === null || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const color = COLORS[tone(v)]

    return (
      <Box>
        <Text color={color} bold>
          ● {headline(v)}{' '}
        </Text>
        <Text>
          {reason(v)} [{v.branch || 'hors depot'}]{' '}
        </Text>
        <Text dimColor>(verdict par depot, autres sessions possibles) </Text>
        <Button key="hide" label="Masquer" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
