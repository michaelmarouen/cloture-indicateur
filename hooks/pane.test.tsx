import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'cloture-indicateur',
  component: 'Pane',
  requestId: 'cloture',
  props: { title: 'Clôture', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const repo = (over: Record<string, unknown>) => ({
  name: 'r', path: 'D:/r', tone: 'ok', nb: 0, gen: 0, fo: 0, ah: 0, ns: 1, jobs: 0, upstream: true, files: [], sessions: ['s'], ...over,
})
const overview = {
  at: 1_700_000_000_000,
  jobsRead: true,
  repos: [
    repo({ name: 'heretic', tone: 'stop', nb: 2, gen: 1, ah: 1, files: ['pyproject.toml', 'uv.lock'], sessions: ['E2E'] }),
    repo({ name: 'heretic-ui', tone: 'warn', upstream: false }),
    repo({ name: 'tradeManager' }),
  ],
}

function seed(values: Record<string, unknown>) {
  return (_: unknown, e: { key: string }) => ({ value: { value: values[e.key], version: 1 } })
}

test('pane shows the answer, 3 checks, the next action and the 4 view buttons', async ($, on) => {
  on('state.get', seed({ overview, view: null, isOverviewBusy: false, isArmed: false, overviewNote: null }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /Non, pas encore/ }))?.text).toContain('1/3')
  expect(await ui.find({ type: 'Text', text: /2 fichiers à sauver dans 1 dépôt/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /1 commit pas encore poussé/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Aucun job lourd en cours/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /heretic : 2 fichiers à commiter ou écarter, dont pyproject.toml/ })).toBeTruthy()
  for (const id of ['depliant', 'liste', 'cartes', 'matrice']) {
    expect(await ui.find({ type: 'Button', key: `view-${id}` })).toBeTruthy()
  }
  expect(await ui.find({ type: 'Button', key: 'commit' })).toBeTruthy()
  await ui.unmount()
})

test('desktop opens on Dépliant (files listed), mobile opens on Cartes', async ($, on) => {
  on('state.get', seed({ overview, view: null, isOverviewBusy: false, isArmed: false, overviewNote: null }))
  const desktop = await $.ui.mount({ ...PANE, requestId: 'cloture', surface: 'desktop' })
  expect(await desktop.find({ type: 'Text', text: /pyproject\.toml$/ })).toBeTruthy()
  await desktop.unmount()

  const mobile = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await mobile.find({ type: 'Text', text: /2 session|1 session/ })).toBeTruthy()
  expect(await mobile.find({ type: 'Text', text: /^uv\.lock$/ })).toBeFalsy()
  await mobile.unmount()
})

test('a chosen view wins over the default, on mobile too', async ($, on) => {
  on('state.get', seed({ overview, view: 'matrice', isOverviewBusy: false, isArmed: false, overviewNote: null }))
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await ui.find({ type: 'Text', text: /Dépôt\s+Sauver/ })).toBeTruthy()
  await ui.unmount()
})

test('armed commit button asks for confirmation', async ($, on) => {
  on('state.get', seed({ overview, view: null, isOverviewBusy: false, isArmed: true, overviewNote: null }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'commit' }))?.text).toMatch(/Confirmer : commiter 1 fichier/)
  await ui.unmount()
})

test('no commit button without generated files', async ($, on) => {
  const none = { ...overview, repos: overview.repos.map(r => ({ ...r, gen: 0 })) }
  on('state.get', seed({ overview: none, view: null, isOverviewBusy: false, isArmed: false, overviewNote: null }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'commit' })).toBeFalsy()
  await ui.unmount()
})

test('empty pane explains itself and a failed read stays visible', async ($, on) => {
  on('state.get', seed({ overview: null, view: null, isOverviewBusy: false, isArmed: false, overviewNote: { ok: false, text: 'lecture impossible : le moteur a répondu 1' } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /lecture impossible/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeTruthy()
  await ui.unmount()
})
