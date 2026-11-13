import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ClotureBase, ClotureNote, ClotureSibling, ClotureVerdict } from '../types'
import { buildMessage, canAsk, parseBase } from './base'
import { BEAT_MS, buildSiblingMessage, classifyNotice, makeLabel, modeMismatch, parseEntry, repoKey, sendAll, siblings, summarize } from './registry'
import { TICK_MS, WAIT_MAX_MS, checkerScript, computeVerdict, describe, extras, headline, parseChecker, reason, shouldRefresh, tone } from './git-state'

const verdict = atom({ plugin: 'cloture-indicateur', key: 'verdict' } as const, null)
const isHidden = atom({ plugin: 'cloture-indicateur', key: 'isHidden' } as const, false)
const baseAtom = atom({ plugin: 'cloture-indicateur', key: 'base' } as const, null)
const siblingsAtom = atom({ plugin: 'cloture-indicateur', key: 'siblings' } as const, [])
const isSiblingsSent = atom({ plugin: 'cloture-indicateur', key: 'isSiblingsSent' } as const, false)
const isWaiting = atom({ plugin: 'cloture-indicateur', key: 'isWaiting' } as const, false)
const sendNote = atom({ plugin: 'cloture-indicateur', key: 'sendNote' } as const, null)
const isSent = atom({ plugin: 'cloture-indicateur', key: 'isSent' } as const, false)

// A turn can only change the repo through these; anything else skips the recompute.
const WRITERS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const COLORS = { ok: 'green', stop: 'red', warn: 'yellow' } as const

let myMode = ''
let lastSendAt = 0
let lastBeat = 0
let waitingSince = 0
let myLabel = ''
let lastAt = 0
let isBusy = false
let isDirty = true

// Baseline of this session: the uncommitted entries already there at its start (kept on reload by the
// checker), so they are not charged to this session. A failure only means no baseline: stays cautious.
async function takeBaseline($: EngineInterface) {
  try {
    const home = await $.env.get('USERPROFILE')
    const id = await $.session.id()
    if (!home || !id) return
    await $.process.run(
      ['python', '-I', checkerScript(home), '--snapshot', await $.session.cwd(), '--out', `${home}\.claude\cloture-baseline\${id}.json`],
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
    if (id) argv.push('--baseline', `${home}\.claude\cloture-baseline\${id}.json`)
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
  if (v && now - lastBeat > BEAT_MS && !isBusy) await syncRegistry($, v)
  const age = now - lastAt
  if (!isBusy && shouldRefresh(v?.kind ?? null, age, isDirty, waitingSince > 0)) {
    isDirty = false
    await refresh($)
  }
}

export const register: Register = on => {
  on('session.start', ($, e, next) => {
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
    const note = (await read($, sendNote)) as ClotureNote | null
    const mismatched = modeMismatch(myMode, others)

    return (
      <Box gap={1} flexWrap="wrap">
        <Text color={color} bold>
          ● {headline(v)}
        </Text>
        <Text>· {reason(v)}</Text>
        {v.kind !== 'PROPRE' && extras(v) ? <Text dimColor>{extras(v)}</Text> : null}
        <Text dimColor>· {v.branch || 'hors dépôt'}</Text>
        {waiting && t === 'stop' ? <Text color="yellow">· ⏳ en attente des autres sessions</Text> : null}
        {isWarnable && mismatched.length > 0 ? (
          <Text color="yellow">· ⚠ {mismatched.length} session(s) en mode différent : message à approuver chez elle</Text>
        ) : null}
        {note ? <Text color={note.ok ? 'green' : 'red'}>· {note.ok ? '✓' : '✗'} {note.text}</Text> : null}
        {isWarnable ? (
          <Button
            key="warn"
            variant={isAskable ? 'secondary' : 'primary'}
            label={`${sentSiblings ? 'Reprévenir' : 'Prévenir'} ${others.length} session(s)`}
            onPress={() => warnSiblings($, others, v)}
          />
        ) : null}
        {isAskable && base ? (
          <Button
            key="ask"
            variant="primary"
            label={sent ? 'Redemander à la base' : 'Demander à la base'}
            onPress={() => askBase($, base, v)}
          />
        ) : null}
        <Button key="hide" label="Masquer" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
