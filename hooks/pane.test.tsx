import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'cloture-indicateur',
  component: 'Pane',
  requestId: 'cloture',
  props: { title: 'Clôture', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const repo = (over: Record<string, unknown>) => ({
  name: 'r', path: 'D:/r', tone: 'ok', nb: 0, gen: 0, fo: 0, ah: 0, ns: 1, jobs: 0, upstream: true, files: [], sessions: ['s'], sessionIds: ['s1'], ...over,
})
const overview = {
  at: 1_700_000_000_000,
  jobsRead: true,
  repos: [
    repo({ name: 'heretic', path: 'D:/heretic', tone: 'stop', nb: 2, gen: 1, ah: 1, files: ['pyproject.toml', 'uv.lock'], sessions: ['E2E'], sessionIds: ['me', 'other'] }),
    repo({ name: 'heretic-ui', tone: 'warn', upstream: false }),
    repo({ name: 'tradeManager' }),
  ],
}

const NOW = 1_700_000_005_000
function setup(on: (name: string, fn: (...a: never[]) => unknown) => void, values: Record<string, unknown>) {
  on('state.get', seed(values) as never)
  on('clock.now', (() => ({ value: NOW })) as never)
  on('session.id', (() => ({ value: 'me' })) as never)
}

function seed(values: Record<string, unknown>) {
  return (_: unknown, e: { key: string }) => ({ value: { value: values[e.key], version: 1 } })
}

test('pane shows the answer, 3 checks, the next action and the 4 view buttons', async ($, on) => {
  setup(on, { overview, view: null, isOverviewBusy: false, isArmed: false, overviewNote: null })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /Non, pas encore/ }))?.text).toContain('1/3')
  expect(await ui.find({ type: 'Text', text: /2 fichiers à sauver dans 1 dépôt/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /1 commit pas encore poussé/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Aucun job lourd en cours/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /heretic : 2 fichiers à commiter ou écarter, dont pyproject.toml/ })).toBeTruthy()
  for (const id of ['depliant', 'liste', 'cartes']) {
    expect(await ui.find({ type: 'Button', key: `view-${id}` })).toBeTruthy()
  }
  expect(await ui.find({ type: 'Button', key: 'commit' })).toBeTruthy()
  await ui.unmount()
})

test('desktop opens on Dépliant (files listed), mobile opens on Cartes', async ($, on) => {
  setup(on, { overview, view: null, isOverviewBusy: false, isArmed: false, overviewNote: null })
  const desktop = await $.ui.mount({ ...PANE, requestId: 'cloture', surface: 'desktop' })
  expect(await desktop.find({ type: 'Text', text: /pyproject\.toml$/ })).toBeTruthy()
  await desktop.unmount()

  const mobile = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await mobile.find({ type: 'Text', text: /2 session|1 session/ })).toBeTruthy()
  expect(await mobile.find({ type: 'Text', text: /^uv\.lock$/ })).toBeFalsy()
  await mobile.unmount()
})

test('a chosen view wins over the default, on mobile too', async ($, on) => {
  setup(on, { overview, view: 'liste', isOverviewBusy: false, isArmed: false, overviewNote: null })
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await ui.find({ type: 'Text', text: /heretic · 2 à sauver · 1 à pousser/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'view-matrice' })).toBeFalsy()
  await ui.unmount()
})

test('armed commit button asks for confirmation', async ($, on) => {
  setup(on, { overview, view: null, isOverviewBusy: false, isArmed: true, overviewNote: null })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Button', key: 'commit' }))?.text).toBe('✓ 1')
  await ui.unmount()
})

test('no commit button without generated files', async ($, on) => {
  const none = { ...overview, repos: overview.repos.map(r => ({ ...r, gen: 0 })) }
  setup(on, { overview: none, view: null, isOverviewBusy: false, isArmed: false, overviewNote: null })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'commit' })).toBeFalsy()
  await ui.unmount()
})

test('empty pane explains itself and a failed read stays visible', async ($, on) => {
  setup(on, { overview: null, view: null, isOverviewBusy: false, isArmed: false, overviewNote: { ok: false, text: 'lecture impossible : le moteur a répondu 1' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /lecture impossible/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeTruthy()
  await ui.unmount()
})

for (const [theme, icon, stop] of [['auto', '◐', 'red'], ['clair', '☀', '#b91c1c'], ['sombre', '☾', '#f87171']] as const) {
  test(`theme ${theme}: toggle shows ${icon} and the answer uses its colour`, async ($, on) => {
    setup(on, { overview, view: null, theme, isOverviewBusy: false, isArmed: false, overviewNote: null })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ type: 'Button', key: 'theme' }))?.text).toBe(icon)
    expect(await ui.find({ type: 'Text', text: /Thème : / })).toBeTruthy()
    const head = (await ui.find({ type: 'Text', text: /Non, pas encore/ })) as { props?: { color?: string } } | null
    expect(head?.props?.color).toBe(stop)
    await ui.unmount()
  })
}

test('view and refresh buttons are icon-only', async ($, on) => {
  setup(on, { overview, view: null, theme: 'auto', isOverviewBusy: false, isArmed: false, overviewNote: null })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'view-depliant' }))?.text).toBe('▾')
  expect((await ui.find({ type: 'Button', key: 'view-liste' }))?.text).toBe('≡')
  expect((await ui.find({ type: 'Button', key: 'view-cartes' }))?.text).toBe('▦')
  expect((await ui.find({ type: 'Button', key: 'refresh' }))?.text).toBe('↻')
  expect((await ui.find({ type: 'Button', key: 'close' }))?.text).toBe('✕')
  await ui.unmount()
})

test('each icon button has its label ready for the hover (hidden Text, no label beside the button)', async ($, on) => {
  setup(on, { overview, view: null, theme: 'auto', isOverviewBusy: false, isArmed: false, overviewNote: null })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  for (const label of [/Affichage : Dépliant/, /Affichage : Liste/, /Affichage : Cartes/, /Thème : auto/, /^Actualiser$/, /Fermer le panneau/, /Commiter les fichiers régénérés/]) {
    expect(await ui.find({ type: 'Text', text: label })).toBeTruthy()
  }
  await ui.unmount()
})

test('repos that are clean and pushed are not listed (only counted in the gauge)', async ($, on) => {
  setup(on, { overview, view: 'liste', theme: 'auto', isOverviewBusy: false, isArmed: false, overviewNote: null })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /heretic · 2 à sauver/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /tradeManager/ })).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /Non, pas encore/ }))?.text).toContain('1/3')
  await ui.unmount()
})

test('when every repo is clean the detail says so instead of listing them', async ($, on) => {
  const clean = { ...overview, repos: overview.repos.filter(r => r.tone === 'ok') }
  setup(on, { overview: clean, view: 'cartes', theme: 'auto', isOverviewBusy: false, isArmed: false, overviewNote: null })
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await ui.find({ type: 'Text', text: /Tous les dépôts sont propres et poussés/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Oui, tu peux fermer/ })).toBeTruthy()
  await ui.unmount()
})

test('the age of the reading is shown, and an old reading is flagged', async ($, on) => {
  setup(on, { overview: { ...overview, at: NOW - 3_000 }, view: null, theme: 'auto', isOverviewBusy: false, isArmed: false, overviewNote: null })
  const fresh = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await fresh.find({ type: 'Text', text: /Lu à l'instant/ })).toBeTruthy()
  expect(await fresh.find({ type: 'Text', text: /lecture ancienne/ })).toBeFalsy()
  await fresh.unmount()
})

test('a reading older than 90 s says so', async ($, on) => {
  setup(on, { overview: { ...overview, at: NOW - 200_000 }, view: null, theme: 'auto', isOverviewBusy: false, isArmed: false, overviewNote: null })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Lu il y a 3 min/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /lecture ancienne/ })).toBeTruthy()
  await ui.unmount()
})

test('per-repo buttons: push only with commits and a remote, warn only for repos to save with other sessions', async ($, on) => {
  setup(on, { overview, view: 'liste', theme: 'auto', isOverviewBusy: false, isArmed: false, overviewNote: null, armedPush: null })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'push-heretic' }))?.text).toBe('↑ 1 commit')
  expect((await ui.find({ type: 'Button', key: 'warn-heretic' }))?.text).toBe('✉ 1 session')
  expect(await ui.find({ type: 'Button', key: 'push-heretic-ui' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'warn-heretic-ui' })).toBeFalsy()
  await ui.unmount()
})

test('an armed push asks for a second press', async ($, on) => {
  setup(on, { overview, view: 'cartes', theme: 'auto', isOverviewBusy: false, isArmed: false, overviewNote: null, armedPush: 'D:/heretic' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'push-heretic' }))?.text).toBe('✓ pousser 1 commit ?')
  await ui.unmount()
})

for (const [theme, bg, card] of [['auto', undefined, undefined], ['clair', '#ffffff', '#f3f4f6'], ['sombre', '#1e1e1e', '#2a2a2a']] as const) {
  test(`theme ${theme} paints the whole pane (page and cards), not only the text`, async ($, on) => {
    setup(on, { overview, view: 'liste', theme, isOverviewBusy: false, isArmed: false, overviewNote: null })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const page = (await ui.find({ type: 'Box', props: { backgroundColor: bg } })) as unknown
    if (bg) {
      expect(page).toBeTruthy()
      expect(await ui.find({ type: 'Box', props: { backgroundColor: card } })).toBeTruthy()
    }
    expect(await ui.find({ type: 'Text', text: /Détail · 2 dépôt\(s\) à traiter/ })).toBeTruthy()
    await ui.unmount()
  })
}

test('pressing the armed push button runs git push on that repo, never forced', async ($, on) => {
  const calls: string[][] = []
  setup(on, { overview, view: 'liste', theme: 'auto', isOverviewBusy: true, isArmed: false, overviewNote: null, armedPush: 'D:/heretic' })
  on('state.set', (() => ({ value: { isSet: true, version: 2 } })) as never)
  on('process.run', ((_: unknown, e: { argv: string[] }) => {
    calls.push(e.argv)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  }) as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'push-heretic' })
  expect(calls[0]).toEqual(['git', '-C', 'D:/heretic', 'push'])
  expect(calls[0]!.some(a => /force|-f$/.test(a))).toBe(false)
  await ui.unmount()
})

test('an overview stored by an older version (no sessionIds) still draws', async ($, on) => {
  const old = { ...overview, repos: overview.repos.map(({ sessionIds: _s, ...r }) => r) }
  setup(on, { overview: old, view: 'liste', theme: 'auto', isOverviewBusy: false, isArmed: false, overviewNote: null, armedPush: null })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Non, pas encore/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'warn-heretic' })).toBeFalsy()
  await ui.unmount()
})

test('dark theme: dim texts get a readable colour and every button has a light backing', async ($, on) => {
  setup(on, { overview, view: 'liste', theme: 'sombre', isOverviewBusy: false, isArmed: false, overviewNote: null, armedPush: null })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const age = (await ui.find({ type: 'Text', text: /^Lu / })) as { props?: { color?: string } } | null
  expect(age?.props?.color).toBe('#9ca3af')
  const chipView = (await ui.find({ type: 'Box', key: 'k-view-liste' })) as { props?: { backgroundColor?: string; borderStyle?: string } } | null
  expect(chipView?.props?.backgroundColor).toBe('#2a2a2a')
  expect(chipView?.props?.borderStyle).toBe('round')
  const chipPush = (await ui.find({ type: 'Box', key: 'b-push-heretic' })) as { props?: { backgroundColor?: string; borderStyle?: string } } | null
  expect(chipPush?.props?.backgroundColor).toBe('#2a2a2a')
  expect(chipPush?.props?.borderStyle).toBe('round')
  await ui.unmount()
})
