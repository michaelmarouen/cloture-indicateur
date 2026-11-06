import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'cloture-indicateur',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const stop = { kind: 'NON_COMMITE', dirty: 3, ahead: 1, stash: 0, branch: 'main', worktrees: 0 }
const clean = { kind: 'PROPRE', dirty: 0, ahead: 0, stash: 0, branch: 'main', worktrees: 0 }
const base = { id: 'local_x', baseTitle: 'Fichier Python', title: 'Reprise : mod' }

function seed(values: Record<string, unknown>) {
  return (_: unknown, e: { key: string }) => ({ value: { value: values[e.key], version: 1 } })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`band with work to save, on ${surface}`, async ($, on) => {
    on('state.get', seed({ verdict: stop, isHidden: false, base, isSent: false }))
    const ui = await $.ui.mount({ ...BAND, requestId: 'band', surface })

    expect((await ui.find({ type: 'Text', text: /NE PAS FERMER/ }))?.text).toContain('NE PAS FERMER')
    expect(await ui.find({ type: 'Text', text: /3 fichier|3 non commité/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'ask' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'hide' })).toBeTruthy()
    await ui.unmount()
  })

  test(`clean band has no ask button, on ${surface}`, async ($, on) => {
    on('state.get', seed({ verdict: clean, isHidden: false, base, isSent: false }))
    const ui = await $.ui.mount({ ...BAND, requestId: 'band', surface })

    expect(await ui.find({ type: 'Text', text: /OK POUR FERMER/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'ask' })).toBeFalsy()
    await ui.unmount()
  })
}
