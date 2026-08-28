import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  assertNoSymlinkEscape,
  baselinePath,
  isInside,
  resolveRoot,
  runPath,
  safeJoin
} from '../../src/node/paths.js'

describe('filesystem path safety', () => {
  let sandbox
  let root

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'snapeye-paths-'))
    root = join(sandbox, '.snapeye')
    await mkdir(root)
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('resolves configured roots and recognizes lexical descendants', () => {
    expect(resolveRoot('.snapeye', sandbox)).toBe(resolve(sandbox, '.snapeye'))
    expect(resolveRoot(root, '/ignored')).toBe(root)
    expect(isAbsolute(resolveRoot('.snapeye', sandbox))).toBe(true)
    expect(isInside(root, join(root, 'runs', 'runA'))).toBe(true)
    expect(isInside(root, join(sandbox, 'outside'))).toBe(false)
  })

  it('constructs validated run and baseline paths', () => {
    expect(runPath(root, 'runs', 'run_A-1', 'current.png'))
      .toBe(join(root, 'runs', 'run_A-1', 'current.png'))
    expect(baselinePath(root, 'baselines', 'dashboard.v1', '.png'))
      .toBe(join(root, 'baselines', 'dashboard.v1.png'))
  })

  it.each(['..', '../outside', 'nested/path', 'nested\\path', '/absolute'])
  ('rejects unsafe path segment %j', segment => {
    expect(() => safeJoin(root, segment)).toThrow()
    try {
      safeJoin(root, segment)
    } catch (error) {
      expect(error.code).toBe('INVALID_PATH')
    }
  })

  it('rejects traversal through typed run and baseline helpers', () => {
    expect(() => runPath(root, 'runs', '../run', 'current.png')).toThrow()
    expect(() => runPath(root, 'runs', 'runA', '../current.png')).toThrow()
    expect(() => baselinePath(root, 'baselines', '../dashboard', '.png')).toThrow()
  })

  it.skipIf(process.platform === 'win32')('rejects a symlink at the artifact root', async () => {
    const outside = join(sandbox, 'outside')
    const linkedRoot = join(sandbox, 'linked-root')
    await mkdir(outside)
    await symlink(outside, linkedRoot)

    expect(() => assertNoSymlinkEscape(linkedRoot, linkedRoot)).toThrow()
  })

  it.skipIf(process.platform === 'win32')('rejects a symlink in a target path', async () => {
    const outside = join(sandbox, 'outside')
    const linkedRuns = join(root, 'runs')
    await mkdir(outside)
    await symlink(outside, linkedRuns)

    expect(() => assertNoSymlinkEscape(root, join(linkedRuns, 'runA', 'result.json'))).toThrow()
  })
})
