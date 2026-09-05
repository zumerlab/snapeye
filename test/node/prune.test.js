import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneRuns } from '../../src/node/prune.js'

describe('run pruning', () => {
  let sandbox
  let root
  let baselinesDir
  let runsDir

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'snapeye-prune-'))
    root = join(sandbox, '.snapeye')
    baselinesDir = join(root, 'baselines')
    runsDir = join(root, 'runs')
    await mkdir(baselinesDir, { recursive: true })
    await mkdir(runsDir)
    await writeFile(join(baselinesDir, 'dashboard.png'), 'baseline')
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  async function makeRun (id, finishedAt) {
    const directory = join(runsDir, id)
    await mkdir(directory)
    await writeFile(join(directory, 'result.json'), JSON.stringify({ finishedAt }))
  }

  it('keeps only the newest terminal runs and never touches baselines', async () => {
    await makeRun('oldRun', '2024-01-01T00:00:00.000Z')
    await makeRun('middleRun', '2025-01-01T00:00:00.000Z')
    await makeRun('newRun', '2026-01-01T00:00:00.000Z')

    const result = await pruneRuns({ runsDir, maxRuns: 2 })

    expect(result).toEqual({ kept: ['newRun', 'middleRun'], removed: ['oldRun'] })
    expect(await readdir(runsDir)).toEqual(expect.arrayContaining(['newRun', 'middleRun']))
    await expect(access(join(runsDir, 'oldRun'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(baselinesDir, 'dashboard.png'), 'utf8')).toBe('baseline')
  })

  it('ignores invalid run names and non-directory entries', async () => {
    await makeRun('validRun', '2024-01-01T00:00:00.000Z')
    await mkdir(join(runsDir, 'bad..run'))
    await mkdir(join(runsDir, '.hidden'))
    await writeFile(join(runsDir, 'ordinaryFile'), 'keep')

    const result = await pruneRuns({ runsDir, maxRuns: 0 })

    expect(result.removed).toEqual(['validRun'])
    expect(await readdir(runsDir)).toEqual(expect.arrayContaining([
      'bad..run',
      '.hidden',
      'ordinaryFile'
    ]))
  })

  it('is harmless when the runs directory does not exist', async () => {
    await rm(runsDir, { recursive: true })

    await expect(pruneRuns({ runsDir, maxRuns: 2 }))
      .resolves.toEqual({ kept: [], removed: [] })
    expect(await readFile(join(baselinesDir, 'dashboard.png'), 'utf8')).toBe('baseline')
  })

  it.skipIf(process.platform === 'win32')('does not follow symlinked run entries', async () => {
    const outside = join(sandbox, 'outside-run')
    await mkdir(outside)
    await writeFile(join(outside, 'sentinel'), 'keep')
    await symlink(outside, join(runsDir, 'linkedRun'))
    await makeRun('realRun', '2024-01-01T00:00:00.000Z')

    const result = await pruneRuns({ runsDir, maxRuns: 0 })

    expect(result.removed).toEqual(['realRun'])
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('keep')
    expect((await readdir(runsDir))).toContain('linkedRun')
  })

  it.skipIf(process.platform === 'win32')('rejects a symlink used as the runs root', async () => {
    const outside = join(sandbox, 'outside-root')
    const linkedRuns = join(sandbox, 'linked-runs')
    await mkdir(join(outside, 'victim'), { recursive: true })
    await writeFile(join(outside, 'victim', 'sentinel'), 'keep')
    await symlink(outside, linkedRuns)

    await expect(pruneRuns({ runsDir: linkedRuns, maxRuns: 0 }))
      .rejects.toMatchObject({ code: 'INVALID_PATH' })
    expect(await readFile(join(outside, 'victim', 'sentinel'), 'utf8')).toBe('keep')
  })

  it.skipIf(process.platform === 'win32')('rejects a symlink at the artifact root before pruning', async () => {
    const outside = join(sandbox, 'outside-artifacts')
    const victim = join(outside, 'runs', 'victim')
    await mkdir(victim, { recursive: true })
    await writeFile(join(victim, 'sentinel'), 'keep')
    await rm(root, { recursive: true })
    await symlink(outside, root)

    await expect(pruneRuns({ runsDir, maxRuns: 0 }))
      .rejects.toMatchObject({ code: 'INVALID_PATH' })
    expect(await readFile(join(victim, 'sentinel'), 'utf8')).toBe('keep')
  })
})
