// End-to-end check against REAL git repositories (no mocks): the mod's own computeVerdict,
// and, when present, the optional cloture_check.py --git-only, must give the same answer.
// Run: node --test test/        (Node 22.6+ strips the TypeScript types by itself)
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { promisify } from 'node:util'

import { computeVerdict } from '../hooks/git-state.ts'

const exec = promisify(execFile)
const root = mkdtempSync(join(tmpdir(), 'cloture-e2e-'))
after(() => rmSync(root, { recursive: true, force: true }))

const runIn = cwd => async argv => {
  try {
    const r = await exec(argv[0], argv.slice(1), { cwd, windowsHide: true })
    return { exitCode: 0, stdout: r.stdout, stderr: r.stderr }
  } catch (e) {
    return { exitCode: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

const git = (cwd, ...args) =>
  exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, windowsHide: true })

// A repo with an origin and one pushed commit.
async function pushedRepo(name) {
  const origin = join(root, `${name}-origin.git`)
  const dir = join(root, name)
  mkdirSync(origin)
  await git(origin, 'init', '-q', '--bare', '-b', 'main')
  mkdirSync(dir)
  await git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'a')
  await git(dir, 'add', 'a.txt')
  await git(dir, 'commit', '-q', '-m', 'init')
  await git(dir, 'remote', 'add', 'origin', origin)
  await git(dir, 'push', '-q', '-u', 'origin', 'main')
  return dir
}

const checker = join(homedir(), '.claude', 'scripts', 'cloture_check.py')

async function viaScript(dir) {
  if (!existsSync(checker)) return null
  const r = await exec('python', ['-I', checker, '--git-only', dir], { windowsHide: true })
  return JSON.parse(r.stdout)
}

async function expectBoth(dir, kind, extra = {}) {
  const mod = await computeVerdict(runIn(dir))
  assert.equal(mod.kind, kind, `mod: ${JSON.stringify(mod)}`)
  for (const [k, v] of Object.entries(extra)) assert.equal(mod[k], v, `mod.${k}`)
  const script = await viaScript(dir)
  if (script) {
    assert.equal(script.kind, kind, `script: ${JSON.stringify(script)}`)
    for (const [k, v] of Object.entries(extra)) assert.equal(script[k], v, `script.${k}`)
  }
}

test('outside git: HORS_GIT', async () => {
  const dir = join(root, 'plain')
  mkdirSync(dir)
  await expectBoth(dir, 'HORS_GIT')
})

test('pushed and clean: PROPRE', async () => {
  await expectBoth(await pushedRepo('clean'), 'PROPRE', { dirty: 0, ahead: 0, stash: 0 })
})

test('untracked file: NON_COMMITE', async () => {
  const dir = await pushedRepo('untracked')
  writeFileSync(join(dir, 'new.txt'), 'x')
  await expectBoth(dir, 'NON_COMMITE', { dirty: 1 })
})

test('modified + staged rename + untracked: counted once each', async () => {
  const dir = await pushedRepo('mixed')
  writeFileSync(join(dir, 'a.txt'), 'changed')
  writeFileSync(join(dir, 'b.txt'), 'b')
  await git(dir, 'add', 'b.txt')
  await git(dir, 'commit', '-q', '-m', 'b')
  await git(dir, 'push', '-q')
  renameSync(join(dir, 'b.txt'), join(dir, 'c.txt'))
  await git(dir, 'add', '-A', 'c.txt', 'b.txt')
  writeFileSync(join(dir, 'u.txt'), 'u')
  await expectBoth(dir, 'NON_COMMITE', { dirty: 3 })
})

test('committed but not pushed: NON_POUSSE', async () => {
  const dir = await pushedRepo('ahead')
  writeFileSync(join(dir, 'a.txt'), 'second')
  await git(dir, 'commit', '-q', '-am', 'second')
  await expectBoth(dir, 'NON_POUSSE', { dirty: 0, ahead: 1 })
})

test('no remote at all: SANS_REMOTE', async () => {
  const dir = join(root, 'local')
  mkdirSync(dir)
  await git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'a.txt'), 'a')
  await git(dir, 'add', 'a.txt')
  await git(dir, 'commit', '-q', '-m', 'init')
  await expectBoth(dir, 'SANS_REMOTE')
})

test('a stash is counted', async () => {
  const dir = await pushedRepo('stash')
  writeFileSync(join(dir, 'a.txt'), 'wip')
  await git(dir, 'stash', 'push', '-q')
  await expectBoth(dir, 'PROPRE', { stash: 1 })
})

test('after the commit and push the verdict turns PROPRE again', async () => {
  const dir = await pushedRepo('cycle')
  writeFileSync(join(dir, 'n.txt'), 'n')
  assert.equal((await computeVerdict(runIn(dir))).kind, 'NON_COMMITE')
  await git(dir, 'add', 'n.txt')
  await git(dir, 'commit', '-q', '-m', 'n')
  assert.equal((await computeVerdict(runIn(dir))).kind, 'NON_POUSSE')
  await git(dir, 'push', '-q')
  assert.equal((await computeVerdict(runIn(dir))).kind, 'PROPRE')
})
