import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ClotureBase, ClotureNote, ClotureOverview, ClotureRepo, ClotureSibling, ClotureTheme, ClotureTone, ClotureVerdict, ClotureView } from '../types'
import { buildMessage, canAsk, parseBase } from './base'
import { AUTO_MS, PANE_LIVE_MS, READY_MIN_GAP_MS, THEMES, VIEWS, ageLabel, answer, becameReady, canPush, counts, defaultView, isStale, nextTheme, palette, parseAutoRules, parseOverview, plural, ring, statusText } from './overview'
import { BEAT_MS, FRESH_MS, buildSiblingMessage, classifyNotice, makeLabel, modeMismatch, parseEntry, repoKey, sendAll, siblings, summarize } from './registry'
import { TICK_MS, WAIT_MAX_MS, baselinePath, checkerScript, computeVerdict, describe, extras, headline, parseChecker, reason, shouldRefresh, tone } from './git-state'

const verdict = atom({ plugin: 'cloture-indicateur', key: 'verdict' } as const, null)
const isHidden = atom({ plugin: 'cloture-indicateur', key: 'isHidden' } as const, false)
const baseAtom = atom({ plugin: 'cloture-indicateur', key: 'base' } as const, null)
const siblingsAtom = atom({ plugin: 'cloture-indicateur', key: 'siblings' } as const, [])
const isSiblingsSent = atom({ plugin: 'cloture-indicateur', key: 'isSiblingsSent' } as const, false)
const isWaiting = atom({ plugin: 'cloture-indicateur', key: 'isWaiting' } as const, false)
const sendNote = atom({ plugin: 'cloture-indicateur', key: 'sendNote' } as const, null)
const isSent = atom({ plugin: 'cloture-indicateur', key: 'isSent' } as const, false)
const overviewAtom = atom({ plugin: 'cloture-indicateur', key: 'overview' } as const, null)
const viewAtom = atom({ plugin: 'cloture-indicateur', key: 'view' } as const, null)
// The whole band is tinted by the verdict; white text reads on all three, whatever the pane theme.
const BAND_BG = { stop: '#991b1b', warn: '#92400e', ok: '#166534' } as const
const themeAtom = atom({ plugin: 'cloture-indicateur', key: 'theme' } as const, 'auto')
const isOverviewBusy = atom({ plugin: 'cloture-indicateur', key: 'isOverviewBusy' } as const, false)
const isArmed = atom({ plugin: 'cloture-indicateur', key: 'isArmed' } as const, false)
const overviewNote = atom({ plugin: 'cloture-indicateur', key: 'overviewNote' } as const, null)
const tickAtom = atom({ plugin: 'cloture-indicateur', key: 'tick' } as const, 0)
const armedPush = atom({ plugin: 'cloture-indicateur', key: 'armedPush' } as const, null)

const PANE = 'cloture'

// A turn can only change the repo through these; anything else skips the recompute.
const WRITERS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

let myMode = ''
let lastSendAt = 0
let lastBeat = 0
let waitingSince = 0
let myLabel = ''
let lastAt = 0
let isBusy = false
let isDirty = true
let lastPaneRender = 0
let lastOverviewAt = 0
let overviewTone: ClotureTone | null = null
let lastReadyToastAt = 0

// Baseline of this session: the uncommitted entries already there at its start (kept on reload by the
// checker), so they are not charged to this session. A failure only means no baseline: stays cautious.
async function takeBaseline($: EngineInterface) {
  try {
    const home = await $.env.get('USERPROFILE')
    const id = await $.session.id()
    if (!home || !id) return
    await $.process.run(
      ['python', '-I', checkerScript(home), '--snapshot', await $.session.cwd(), '--out', baselinePath(home, id)],
      { timeoutMs: 15000 },
    )
  } catch {
    /* no baseline */
  }
}

// Optional single source of truth: ~/.claude/scripts/cloture_check.py --git-only.
// Absent or failing, the built-in git logic answers.
async function viaChecker($: EngineInterface, cwd: string): Promise<ClotureVerdict | null> {
  const home = await $.env.get('USERPROFILE')
  if (!home) return null
  const script = checkerScript(home)
  try {
    const argv = ['python', '-I', script, '--git-only', cwd]
    const id = await $.session.id()
    if (id) argv.push('--baseline', baselinePath(home, id))
    const r = await $.process.run(argv, { timeoutMs: 15000 })
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
  const { delivered, failures } = await sendAll([{ id: base.id, label: base.baseTitle, mode: '' }], async id => {
    const first = await $.session.send({ to: { sessionId: id }, text })
    return first.isDelivered ? first : await $.session.send({ to: id, text })
  })
  const note = summarize(1, delivered, failures)
  await update($, sendNote, () => ({ ok: note.ok, text: `base : ${note.text}` }))
  if (delivered > 0) {
    await update($, isSent, () => true)
    await startWaiting($)
  }
  $.ui.toast(note.ok ? `Message envoyé à la session de base${base.baseTitle ? ` « ${base.baseTitle} »` : ''}` : `Envoi à la base : ${note.text}`)
}

// Registry: one small file per live session, so a session finds the others on its repo.
async function registryDir($: EngineInterface): Promise<string | null> {
  const home = await $.env.get('USERPROFILE')
  return home ? `${home}/.claude/cloture-registry` : null
}

async function syncRegistry($: EngineInterface, v: ClotureVerdict) {
  const dir = await registryDir($)
  if (!dir || v.kind === 'HORS_GIT') {
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
  await $.fs.write(`${dir}/${id}.json`, JSON.stringify({ id, repo, label: myLabel, updatedAt: now, mode: myMode }))
  lastBeat = now
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
  const now = await $.clock.now()
  if (now - lastSendAt < 15_000) {
    $.ui.toast('Attends quelques secondes avant de renvoyer.')
    return
  }
  lastSendAt = now
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
  const stamp = `envoi de ${new Date(now).toTimeString().slice(0, 8)}`
  const text = buildSiblingMessage(myLabel, v, top.stdout.trim() || (await $.session.cwd()), stamp)
  const { delivered, failures } = await sendAll(others, id => $.session.send({ to: { sessionId: id }, text }))
  const note = summarize(others.length, delivered, failures)
  const mismatched = modeMismatch(myMode, others)
  const warning = mismatched.length > 0 ? ` | ${mismatched.length} en mode différent de ${myMode} : message possiblement retenu, à approuver dans cette session` : ''
  await update($, sendNote, () => ({ ok: note.ok && mismatched.length === 0, text: note.text + warning }))
  if (delivered > 0) {
    await update($, isSiblingsSent, () => true)
    await startWaiting($)
  }
  $.ui.toast(note.text + warning)
}

// The engine's own delivery notices (held, approved, denied, expired, dropped) replace the optimistic note.
async function onNotice($: EngineInterface, text: string) {
  const n = classifyNotice(text)
  if (!n) return
  await update($, sendNote, () => ({ ok: n.ok, text: n.text }))
  if (n.isFinal && !n.ok) await stopWaiting($)
  $.ui.toast(n.text)
}

// A mode learned after the entry was written is published at once, not a minute later.
async function setMode($: EngineInterface, mode: string | undefined) {
  if (!mode || mode === myMode) return
  myMode = mode
  const v = (await read($, verdict)) as ClotureVerdict | null
  if (v) await syncRegistry($, v)
}

// A closed session says so: its entry is rewritten with updatedAt 0, which nobody counts as live.
async function tombstone($: EngineInterface) {
  const dir = await registryDir($)
  if (!dir) return
  const id = await $.session.id()
  await $.fs.write(`${dir}/${id}.json`, JSON.stringify({ id, repo: '', label: '', updatedAt: 0, mode: myMode }))
}

// Whole-machine view for the pane: every live session of the registry, handed to the same checker the
// /cloture web page uses. On demand only (about 7 s for six repos), never on the band's timer.
let overviewRunningSince = 0
async function loadOverview($: EngineInterface) {
  // The busy flag is persisted: after a reload mid-read it stays true forever. Only this module instance knows a read is live.
  if ((await read($, isOverviewBusy)) && overviewRunningSince && (await $.clock.now()) - overviewRunningSince < 70000) return
  overviewRunningSince = await $.clock.now()
  await update($, isOverviewBusy, () => true)
  try {
    const home = await $.env.get('USERPROFILE')
    const dir = await registryDir($)
    if (!home || !dir) throw new Error('profil introuvable')
    const now = await $.clock.now()
    const live = []
    for (const f of await $.fs.list(dir)) {
      if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
      const entry = parseEntry(String(await $.fs.read(`${dir}/${f.name}`)))
      if (entry && entry.repo && now - entry.updatedAt <= FRESH_MS) {
        live.push({ sessionId: entry.id, title: entry.label, cwd: entry.repo, isRunning: false })
      }
    }
    const file = `${home.replace(/\\/g, '/')}/.claude/cloture-overview-sessions.json`
    await $.fs.write(file, JSON.stringify(live))
    const r = await $.process.run(['python', '-I', checkerScript(home), '--sessions', file, '--json'], { timeoutMs: 60000 })
    const parsed = r.exitCode === 0 ? parseOverview(r.stdout, now, (await readAutoRules($, home)).sync) : null
    if (!parsed) throw new Error(`le moteur a répondu ${r.exitCode}`)
    await update($, overviewAtom, () => parsed)
    await update($, overviewNote, () => null)
    lastOverviewAt = now
    const a = answer(parsed)
    $.ui.status(statusText(a))
    if (becameReady(overviewTone, a.tone) && now - lastReadyToastAt > READY_MIN_GAP_MS) {
      lastReadyToastAt = now
      $.ui.toast('Oui, tu peux fermer : tous les dépôts sont prêts')
    }
    overviewTone = a.tone
  } catch (err) {
    await update($, overviewNote, () => ({ ok: false, text: `lecture impossible : ${err instanceof Error ? err.message : 'erreur'}` }))
  } finally {
    overviewRunningSince = 0
    await update($, isOverviewBusy, () => false)
  }
}

// The band opens the pane, and closes it when it is already up (the engine's own list of this plugin's panes).
async function togglePane($: EngineInterface) {
  if ((await $.ui.panes()).some(p => p.id === PANE)) await $.ui.close({ id: PANE })
  else await openPane($)
}

async function openPane($: EngineInterface) {
  lastPaneRender = await $.clock.now()
  await $.ui.open({ id: PANE, title: 'Clôture' })
  void loadOverview($)
}

// Two presses: the first arms the button, the second commits (by pathspec, generated files only, in the checker).
async function commitGenerated($: EngineInterface, o: ClotureOverview) {
  if (!(await read($, isArmed))) {
    await update($, isArmed, () => true)
    return
  }
  await update($, isArmed, () => false)
  const home = await $.env.get('USERPROFILE')
  if (!home) return
  const lines: string[] = []
  let ok = true
  for (const repo of o.repos.filter(x => x.gen > 0)) {
    const r = await $.process.run(['python', '-I', checkerScript(home), '--commit-generated', repo.path], { timeoutMs: 60000 })
    let res: { ok?: boolean; committed?: number; detail?: string } = {}
    try {
      res = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}')
    } catch {
      // not JSON: treated as a refusal below
    }
    const done = r.exitCode === 0 && res.ok === true && (res.committed ?? 0) > 0
    ok = ok && done
    lines.push(`${repo.name} : ${done ? `${res.committed} fichier(s) commité(s)` : `refusé (${res.detail || (r.stderr || r.stdout).trim().slice(0, 80) || 'rien à commiter'})`}`)
  }
  // The read below clears any note, so the result is written after it.
  await loadOverview($)
  await update($, overviewNote, () => ({ ok, text: lines.join(' | ') || 'aucun fichier régénéré' }))
}

// Repos that ask for it ("auto_commit_generated" in cloture_rules.json) get their generated/evidence files committed without a click,
// by pathspec, at the end of a turn.
async function readAutoRules($: EngineInterface, home: string) {
  try {
    return parseAutoRules(String(await $.fs.read(`${home.replace(/\\/g, '/')}/.claude/cloture_rules.json`)))
  } catch {
    return parseAutoRules('')
  }
}
const AUTO_GENERATED_GAP_MS = 5 * 60_000
let lastAutoGeneratedAt = 0
async function autoCommitGenerated($: EngineInterface) {
  const now = await $.clock.now()
  if (now - lastAutoGeneratedAt < AUTO_GENERATED_GAP_MS) return
  lastAutoGeneratedAt = now
  const home = await $.env.get('USERPROFILE')
  if (!home) return
  for (const repo of (await readAutoRules($, home)).generated) {
    try {
      await $.process.run(['python', '-I', checkerScript(home), '--commit-generated', repo], { timeoutMs: 60000 })
    } catch {
      // The checker refuses on its own when the index holds anything else; nothing to report here.
    }
  }
}

// Push of the commits already made, one repo, two presses, never forced: a refusal (remote ahead...) is shown as is.
async function pushRepo($: EngineInterface, r: ClotureRepo) {
  if ((await read($, armedPush)) !== r.path) {
    await update($, armedPush, () => r.path)
    return
  }
  await update($, armedPush, () => null)
  try {
    const res = await $.process.run(['git', '-C', r.path, 'push'], { timeoutMs: 60000 })
    const detail = (res.stderr || res.stdout).trim().split('\n').pop()?.trim().slice(0, 100) ?? ''
    await loadOverview($)
    await update($, overviewNote, () => ({ ok: res.exitCode === 0, text: `${r.name} : ${res.exitCode === 0 ? 'poussé' : `refusé (${detail})`}` }))
  } catch (err) {
    await update($, overviewNote, () => ({ ok: false, text: `${r.name} : push impossible (${err instanceof Error ? err.message : 'erreur'})` }))
  }
}

// Warn the other sessions of one repo (the message is the same one the band sends).
async function warnRepo($: EngineInterface, r: ClotureRepo) {
  const me = await $.session.id()
  const targets = (r.sessionIds ?? []).filter(id => id !== me).map(id => ({ id, label: '', mode: '' }))
  if (targets.length === 0) return
  const now = await $.clock.now()
  if (now - lastSendAt < 15_000) {
    $.ui.toast('Attends quelques secondes avant de renvoyer.')
    return
  }
  lastSendAt = now
  const v: ClotureVerdict = { kind: r.nb > 0 ? 'NON_COMMITE' : 'NON_POUSSE', dirty: r.nb, ahead: r.ah, stash: 0, branch: '', worktrees: 0 }
  const text = buildSiblingMessage(myLabel, v, r.path, `envoi de ${new Date(now).toTimeString().slice(0, 8)}`)
  const { delivered, failures } = await sendAll(targets, id => $.session.send({ to: { sessionId: id }, text }))
  const note = summarize(targets.length, delivered, failures)
  await update($, overviewNote, () => ({ ok: note.ok, text: `${r.name} : ${note.text}` }))
  $.ui.toast(`${r.name} : ${note.text}`)
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
      await update($, sendNote, () => null)
      if (waitingSince > 0) {
        await stopWaiting($)
        $.ui.toast('Tout est commité et poussé : tu peux fermer cette session')
      }
    }
    if (previous?.kind !== next.kind) await update($, isHidden, () => false)
    if (overviewTone === null) $.ui.status(`cloture: ${describe(next)}`)
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
  if (v && now - lastBeat > BEAT_MS && !isBusy) await syncRegistry($, v)
  // Pane open (it rendered lately): re-read the whole machine every AUTO_MS and redraw the age. A closed
  // pane stops rendering, so this stops by itself.
  if (now - lastPaneRender < PANE_LIVE_MS) {
    await update($, tickAtom, () => now)
    if (now - lastOverviewAt >= AUTO_MS) void loadOverview($)
  }
  const age = now - lastAt
  if (!isBusy && shouldRefresh(v?.kind ?? null, age, isDirty, waitingSince > 0)) {
    isDirty = false
    await refresh($)
  }
}

export const register: Register = on => {
  on('command.run', { command: 'cloture' }, async $ => {
    await openPane($)
    return { text: 'Panneau Clôture ouvert.' }
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'cloture', description: 'Ouvre le panneau Clôture : réponse unique, détail par dépôt en 4 affichages' })
    $.clock.after(0, () => void takeBaseline($).then(() => refresh($)))
    $.clock.every(TICK_MS, () => void tick($))
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await setMode($, (e as { permission_mode?: string }).permission_mode)
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    await setMode($, (e as { permission_mode?: string }).permission_mode)
    return next(e)
  })

  on('session.receive', async ($, e, next) => {
    await onNotice($, e.text)
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    const content = (e.message as { content?: unknown }).content
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? '')
    if (text.includes('Cross-session delivery notice')) await onNotice($, text)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await tombstone($)
    return next(e)
  })

  on('tool.call', ($, e, next) => {
    if (WRITERS.has(String(e.tool)) || String(e.tool).startsWith('mcp__')) isDirty = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    $.clock.after(0, () => void tick($))
    $.clock.after(0, () => void autoCommitGenerated($))
    $.clock.after(0, () => void ($.clock.now().then(n => (n - lastOverviewAt >= READY_MIN_GAP_MS ? loadOverview($) : undefined))))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = (await read($, verdict)) as ClotureVerdict | null
    if (e.props.hasSurvey || v === null || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const t = tone(v)
    const pal = palette(((await read($, themeAtom)) as ClotureTheme) ?? 'auto')
    const color = pal[t]
    const base = (await read($, baseAtom)) as ClotureBase | null
    const sent = await read($, isSent)
    const isAskable = canAsk(v, base)
    const others = (await read($, siblingsAtom)) as ClotureSibling[]
    const sentSiblings = await read($, isSiblingsSent)
    const isWarnable = t === 'stop' && others.length > 0
    const waiting = await read($, isWaiting)
    const note = (await read($, sendNote)) as ClotureNote | null
    const mismatched = modeMismatch(myMode, others)

    // Chrome-free, white glyph only (no white block behind it).
    const pill = (t: keyof typeof BAND_BG, key: string, _variant: 'primary' | 'secondary', text: string, onPress: () => void) => (
      <Box key={`b-${key}`}>
        <Button key={key} variant="primary" onPress={onPress}>
          <Text bold color="#ffffff">{text}</Text>
        </Button>
      </Box>
    )

    // One line at any width: the text cuts with an ellipsis, the icons keep their room.
    return (
      <Box gap={1} flexWrap="nowrap" alignItems="center" paddingX={1}>
        <Box key="toggle-box" flexGrow={1} flexShrink={1} minWidth={0}>
          <Text wrap="truncate-end">
            <Text bold>{t === 'ok' ? '🟢' : t === 'warn' ? '🟠' : '🔴'} {headline(v)}</Text>
            <Text> · {reason(v)}</Text>
            {v.kind !== 'PROPRE' && extras(v) ? <Text dimColor> {extras(v)}</Text> : null}
            <Text dimColor> · {v.branch || 'hors dépôt'}</Text>
            {waiting && t === 'stop' ? <Text> · ⏳ en attente des autres sessions</Text> : null}
            {isWarnable && mismatched.length > 0 ? (
              <Text> · ⚠ {mismatched.length} session(s) en mode différent : message à approuver chez elle</Text>
            ) : null}
            {note ? <Text bold> · {note.ok ? '✓' : '✗'} {note.text}</Text> : null}
          </Text>
        </Box>
        <Box gap={1} flexShrink={0} flexWrap="nowrap">
          {isWarnable ? pill(t, 'warn', isAskable ? 'secondary' : 'primary', `${sentSiblings ? '↻' : '✉'} ${others.length}`, () => warnSiblings($, others, v)) : null}
          {isAskable && base ? pill(t, 'ask', 'primary', sent ? '↻ base' : 'base', () => askBase($, base, v)) : null}
          {pill(t, 'detail', 'secondary', '▤', () => togglePane($))}
          {pill(t, 'hide', 'secondary', '✕', () => update($, isHidden, () => true))}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const nowMs = await $.clock.now()
    lastPaneRender = nowMs
    await read($, tickAtom)
    const me = await $.session.id()
    const armedRepo = (await read($, armedPush)) as string | null
    const o = (await read($, overviewAtom)) as ClotureOverview | null
    const busy = await read($, isOverviewBusy)
    const note = (await read($, overviewNote)) as ClotureNote | null
    const armed = await read($, isArmed)
    const chosen = (await read($, viewAtom)) as ClotureView | null
    const view = chosen ?? defaultView(e.surface)
    const theme = ((await read($, themeAtom)) as ClotureTheme) ?? 'auto'
    const pal = palette(theme)

    // The theme paints the whole pane (page background and cards), not only the text colours.
    const frame = (children: unknown) => (
      <Box flexDirection="column" gap={1} paddingX={1} backgroundColor={pal.bg} minHeight={e.props.scroll.bodyRows}>
        {children}
      </Box>
    )
    const refreshButton = (c: string | undefined) => (
      <Box key="refresh" hover={{ scope: 'h-refresh-btn' }}>
        <Button key="refresh" variant={c === 'white' ? 'primary' : undefined} plain={c === 'white' ? undefined : true} onPress={() => loadOverview($)}>
          <Text bold color={c}>{busy ? '…' : '↻'}</Text>
        </Button>
      </Box>
    )
    if (!o) {
      return frame(
        <Box flexDirection="column" gap={1}>
          <Text bold color={pal.text}>Clôture des sessions</Text>
          <Text dimColor={!pal.dim} color={pal.dim}>{busy ? 'Lecture de l’état des dépôts (environ 7 s)…' : 'Aucune lecture pour le moment.'}</Text>
          {note ? <Text color={pal.stop}>✗ {note.text}</Text> : null}
          {refreshButton(pal.text)}
        </Box>,
      )
    }

    const a = answer(o)
    const when = new Date(o.at).toTimeString().slice(0, 8)
    const stale = isStale(o.at, nowMs)
    const repoButtons = (r: ClotureRepo) => {
      const others = (r.sessionIds ?? []).filter(id => id !== me).length
      const back = (key: string, b: unknown, tone: string = pal.text ?? pal.ok) => (
        <Box key={`b-${key}`} borderStyle="round" borderColor={tone} backgroundColor={pal.card} paddingX={1}>
          {b}
        </Box>
      )
      return [
        canPush(r) ? back(`push-${r.name}`, (
          <Button key={`push-${r.name}`} plain onPress={() => pushRepo($, r)}>
            <Text bold color={armedRepo === r.path ? pal.ok : pal.warn}>{armedRepo === r.path ? `✓ confirmer l’envoi de ${r.ah} commit${r.ah > 1 ? 's' : ''} ?` : `↑ envoyer ${r.ah} commit${r.ah > 1 ? 's' : ''}`}</Text>
          </Button>
        ), armedRepo === r.path ? pal.ok : pal.warn) : null,
        r.tone === 'stop' && others > 0 ? back(`warn-${r.name}`, (
          <Button key={`warn-${r.name}`} plain onPress={() => warnRepo($, r)}>
            <Text bold color={pal.stop}>{`✉ prévenir ${others} session${others > 1 ? 's' : ''}`}</Text>
          </Button>
        ), pal.stop) : null,
      ]
    }
    const hero = BAND_BG[a.tone]
    // One segment control per group; each cell carries a hover scope that reveals its help line below.
    const cell = (id: string, label: string, active: boolean, key: string, glyph: string, onPress: () => void) => ({
      id,
      label,
      node: (
        <Box key={`k-${id}`} hover={{ scope: `h-${id}` }} paddingX={1}>
          <Button key={key} plain onPress={onPress}>
            <Text bold={active} underline={active} color={active ? pal[a.tone] : pal.dim ?? pal.text}>{glyph}</Text>
          </Button>
        </Box>
      ),
    })
    const viewCells = VIEWS.map(v => cell(`view-${v.id}`, `Affichage : ${v.label}`, v.id === view, `view-${v.id}`, v.icon, () => update($, viewAtom, () => v.id)))
    const themeCells = THEMES.map(th => cell(`theme-${th.id}`, `Thème : ${th.label}`, th.id === theme, `theme-${th.id}`, th.icon, () => update($, themeAtom, () => th.id)))
    const commitCell = a.generated > 0
      ? [cell('commit', armed ? 'Appuie encore pour confirmer le commit' : 'Commiter les fichiers régénérés', armed, 'commit', armed ? `✓ confirmer le commit (${a.generated})` : `⤓ commiter ${a.generated} généré(s) · ${o.repos.reduce((n, r) => n + r.nb, 0)} non commité(s)`, () => commitGenerated($, o))]
      : []
    const helps = [...commitCell, ...viewCells, ...themeCells, { id: 'refresh', label: 'Actualiser', node: null }, { id: 'close', label: 'Fermer le panneau', node: null }]
    const segment = (cells: { node: unknown }[]) => (
      <Box borderStyle="round" borderColor={pal.dim ?? pal.text ?? pal.ok} backgroundColor={pal.card}>
        {cells.map(c => c.node)}
      </Box>
    )
    const shown = o.repos.filter(r => r.tone !== 'ok')
    return frame(
      <Box flexDirection="column" gap={1}>
        <Box gap={1} flexWrap="wrap">
          {commitCell.length > 0 ? segment(commitCell) : null}
          {segment(viewCells)}
          {segment(themeCells)}
        </Box>
        <Box height={1}>
          {helps.map(t => (
            <Box key={`l-${t.id}`} display="none" hover={{ scope: `h-${t.id}`, display: 'flex' }}>
              <Text color={pal.text}>{t.label}</Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection="column" paddingX={1} backgroundColor={hero}>
          <Box justifyContent="space-between">
            <Text bold color="white">Clôture des sessions</Text>
            <Box gap={1} hover={{ scope: 'h-refresh' }}>
              {refreshButton('white')}
              <Box hover={{ scope: 'h-close' }}>
                <Button key="close" variant="primary" onPress={() => $.ui.close({ id: PANE })}>
                  <Text bold color="white">✕</Text>
                </Button>
              </Box>
            </Box>
          </Box>
          <Text bold color="white">{a.headline}</Text>
          <Text color="white">
            <Text bold>Prochaine action : </Text>
            {a.next}
          </Text>
        </Box>
        <Text color={stale ? pal.warn : pal.dim} dimColor={!stale && !pal.dim}>
          Lu {ageLabel(o.at, nowMs)} ({when}) : {plural(o.repos.reduce((n, r) => n + r.ns, 0), 'session ouverte', 'sessions ouvertes')} dans {plural(o.repos.length, 'dépôt', 'dépôts')}{stale ? ' · lecture ancienne, ↻ pour relire' : ''}
        </Text>
        <Text dimColor={!pal.dim} color={pal.dim}>✎ fichiers modifiés à sauver · ↑ commits à envoyer · ✉ autres sessions à prévenir</Text>
        {note ? <Text color="white" bold>{note.ok ? '✓' : '✗'} {note.text}</Text> : null}
        <Box flexDirection="column" borderStyle="round" borderColor={pal.text} backgroundColor={pal.card} paddingX={1}>
          <Text bold color={pal.text}>Détail · {shown.length === 0 ? 'rien à traiter' : `${shown.length} dépôt(s) à traiter`}</Text>
        {shown.length === 0 ? (
          <Text color={pal.ok}>✓ Tous les dépôts sont propres et poussés.</Text>
        ) : (
          <Box flexDirection="column">
            {shown.map(r => (
              <Box key={`r-${r.path}`} flexDirection="column">
                <Box gap={1} flexWrap="wrap" alignItems="center">
                  <Box flexShrink={1} minWidth={0}>
                  <Text color={pal[r.tone]}>
                    {r.tone === 'ok' ? '✓' : r.tone === 'stop' ? '✕' : '!'} <Text bold color={pal.text}>{r.name}</Text> · {counts(r)}
                  </Text>
                  </Box>
                  <Box gap={1} flexWrap="wrap">{repoButtons(r)}</Box>
                </Box>
                {view === 'depliant' && r.tone === 'stop' ? (
                  <Box flexDirection="column" paddingLeft={2}>
                    {r.files.map(f => (
                      <Text dimColor={!pal.dim} color={pal.dim}>{f}</Text>
                    ))}
                    {r.nb > r.files.length ? <Text dimColor={!pal.dim} color={pal.dim}>… et {r.nb - r.files.length} autre(s)</Text> : null}
                    <Text dimColor={!pal.dim} color={pal.dim}>{r.ns} session(s) : <Text bold color={pal.text}>{r.sessions.slice(0, 3).join(', ')}</Text></Text>
                  </Box>
                ) : null}
              </Box>
            ))}
          </Box>
        )}
        </Box>
      </Box>,
    )
  })
}
