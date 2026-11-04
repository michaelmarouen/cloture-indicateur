import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ClotureVerdict } from '../types'
import { computeVerdict, describe } from './git-state'

const verdict = atom({ plugin: 'cloture-indicateur', key: 'verdict' } as const, null)
const isHidden = atom({ plugin: 'cloture-indicateur', key: 'isHidden' } as const, false)

async function refresh($: EngineInterface) {
  const previous = (await read($, verdict)) as ClotureVerdict | null
  const next = await computeVerdict(argv => $.process.run(argv, { timeoutMs: 10000 }))
  await update($, verdict, () => next)
  $.ui.status(`cloture: ${describe(next)}`)
  if (previous && previous.kind !== 'PROPRE' && next.kind === 'PROPRE') {
    $.ui.toast('Depot propre : tu peux fermer cette session')
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = (await read($, verdict)) as ClotureVerdict | null
    if (e.props.hasSurvey || v === null || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text dimColor>
          {describe(v)} [{v.branch || "hors depot"}] (verdict par depot, autres sessions possibles){' '}
        </Text>
        <Button key="hide" label="Masquer" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
