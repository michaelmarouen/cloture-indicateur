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
const others = [{ id: 's1', label: 'Autre session', mode: 'default' }]
const base = { id: 'local_x', baseTitle: 'Fichier Python', title: 'Reprise : mod' }

function seed(values: Record<string, unknown>) {
  return (_: unknown, e: { key: string }) => ({ value: { value: values[e.key], version: 1 } })
}

const waitingSeed = { verdict: stop, isHidden: false, base, isSent: true, siblings: others, isSiblingsSent: true, isWaiting: true }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`band with work to save, on ${surface}`, async ($, on) => {
    on('state.get', seed({ verdict: stop, isHidden: false, base, isSent: false, siblings: others, isSiblingsSent: false, isWaiting: false }))
    const ui = await $.ui.mount({ ...BAND, requestId: 'band', surface })

    expect(await ui.find({ type: 'Button', key: 'warn' })).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /NE PAS FERMER/ }))?.text).toContain('NE PAS FERMER')
    expect(await ui.find({ type: 'Text', text: /3 fichier|3 non commité/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'ask' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'hide' })).toBeTruthy()
    await ui.unmount()
  })

  test(`clean band has no ask button, on ${surface}`, async ($, on) => {
    on('state.get', seed({ verdict: clean, isHidden: false, base, isSent: false, siblings: others, isSiblingsSent: false, isWaiting: false }))
    const ui = await $.ui.mount({ ...BAND, requestId: 'band', surface })

    expect(await ui.find({ type: 'Button', key: 'warn' })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /OK POUR FERMER/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'ask' })).toBeFalsy()
    await ui.unmount()
  })
}

test('waiting line is shown after a request', async ($, on) => {
  on('state.get', seed(waitingSeed))
  const ui = await $.ui.mount({ ...BAND, requestId: 'band', surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /en attente des autres sessions/ })).toBeTruthy()
  await ui.unmount()
})

test('a failed send stays visible with its reason', async ($, on) => {
  on('state.get', seed({ verdict: stop, isHidden: false, base: null, isSent: false, siblings: others, isSiblingsSent: false, isWaiting: false, sendNote: { ok: false, text: '0/1 session(s) prévenue(s) : recipient gone' } }))
  const ui = await $.ui.mount({ ...BAND, requestId: 'band', surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /0\/1 session.*recipient gone/ })).toBeTruthy()
  await ui.unmount()
})
