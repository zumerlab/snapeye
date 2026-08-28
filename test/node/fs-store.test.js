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
import { buildErrorResult, buildResult } from '../../src/core/result.js'
import { ERROR_CODES } from '../../src/core/protocol.js'
import { createFsArtifactStore } from '../../src/node/fs-store.js'

describe('filesystem artifact store', () => {
  let sandbox
  let root
  let store

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'snapeye-store-'))
    root = join(sandbox, '.snapeye')
    store = createFsArtifactStore({ root })
    await store.ensureLayout()
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('creates the isolated baseline and run layout', async () => {
    await expect(access(store.paths.baselines)).resolves.toBeUndefined()
    await expect(access(store.paths.runs)).resolves.toBeUndefined()
    expect(await store.readBaseline('missing')).toBeNull()
    expect(await store.readResult('missingRun')).toBeNull()
  })

  it('writes and atomically replaces Blob baselines with metadata', async () => {
    await store.writeBaseline('dashboard', {
      image: new Blob(['first'], { type: 'image/png' }),
      meta: { schemaVersion: 1, scale: 1 }
    })
    await store.writeBaseline('dashboard', {
      image: new Blob(['second'], { type: 'image/png' }),
      meta: { schemaVersion: 1, scale: 2 }
    })

    const baseline = await store.readBaseline('dashboard')
    expect(baseline.name).toBe('dashboard')
    expect(baseline.image.toString()).toBe('second')
    expect(baseline.meta).toEqual({ schemaVersion: 1, scale: 2 })
    const storedMetadata = JSON.parse(await readFile(join(store.paths.baselines, 'dashboard.json'), 'utf8'))
    expect(storedMetadata).toMatchObject({
      schemaVersion: 1,
      scale: 2,
      __snapeyeBaselineCommit: {
        format: 'snapeye-baseline-v1',
        state: 'committed',
        generation: expect.any(String),
        image: {
          algorithm: 'sha256',
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          byteLength: 6
        }
      }
    })
    expect((await readdir(store.paths.baselines)).some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it('serializes concurrent replacements of the same name across store instances', async () => {
    let releaseFirst
    const firstReady = new Promise(resolve => { releaseFirst = resolve })
    class GatedBlob extends Blob {
      async arrayBuffer () {
        await firstReady
        return super.arrayBuffer()
      }
    }

    const completionOrder = []
    const first = store.writeBaseline('concurrent', {
      image: new GatedBlob(['first']),
      meta: { generation: 'first' }
    }).then(() => completionOrder.push('first'))
    const restartedStore = createFsArtifactStore({ root })
    const second = restartedStore.writeBaseline('concurrent', {
      image: new Blob(['second']),
      meta: { generation: 'second' }
    }).then(() => completionOrder.push('second'))

    releaseFirst()
    await Promise.all([first, second])

    expect(completionOrder).toEqual(['first', 'second'])
    const baseline = await store.readBaseline('concurrent')
    expect(baseline.image.toString()).toBe('second')
    expect(baseline.meta).toEqual({ generation: 'second' })
  })

  it('rejects a PNG mixed with the commit marker from another generation', async () => {
    await store.writeBaseline('mixed', {
      image: new Blob(['committed']),
      meta: { generation: 'committed' }
    })
    await writeFile(join(store.paths.baselines, 'mixed.png'), 'uncommitted replacement')

    await expect(store.readBaseline('mixed')).rejects.toMatchObject({
      code: 'BASELINE_INTEGRITY'
    })
  })

  it('rejects the pending marker left by an interrupted replacement', async () => {
    await store.writeBaseline('interrupted', {
      image: new Blob(['previous']),
      meta: { generation: 'previous' }
    })
    const metaPath = join(store.paths.baselines, 'interrupted.json')
    const metadata = JSON.parse(await readFile(metaPath, 'utf8'))
    metadata.__snapeyeBaselineCommit = {
      format: 'snapeye-baseline-v1',
      state: 'pending',
      generation: 'interrupted-write'
    }
    await writeFile(metaPath, JSON.stringify(metadata))

    await expect(store.readBaseline('interrupted')).rejects.toMatchObject({
      code: 'BASELINE_INTEGRITY'
    })
  })

  it('keeps legacy baseline pairs readable without an integrity marker', async () => {
    await writeFile(join(store.paths.baselines, 'legacy.png'), 'legacy image')
    await writeFile(join(store.paths.baselines, 'legacy.json'), JSON.stringify({
      schemaVersion: 1,
      source: 'legacy'
    }))

    const baseline = await store.readBaseline('legacy')
    expect(baseline.image.toString()).toBe('legacy image')
    expect(baseline.meta).toEqual({ schemaVersion: 1, source: 'legacy' })

    await writeFile(join(store.paths.baselines, 'pngOnly.png'), 'legacy png')
    expect(await store.readBaseline('pngOnly')).toMatchObject({ name: 'pngOnly', meta: null })
  })

  it('does not expose or overwrite a caller metadata property matching the internal key', async () => {
    const meta = {
      schemaVersion: 1,
      __snapeyeBaselineCommit: { ownedBy: 'caller' }
    }
    await store.writeBaseline('reserved-key', { image: new Blob(['image']), meta })

    expect((await store.readBaseline('reserved-key')).meta).toEqual(meta)
  })

  it('validates metadata before invalidating an existing baseline', async () => {
    await store.writeBaseline('unchanged', {
      image: new Blob(['stable']),
      meta: { generation: 'stable' }
    })
    const circular = {}
    circular.self = circular

    await expect(store.writeBaseline('unchanged', {
      image: new Blob(['replacement']),
      meta: circular
    })).rejects.toThrow()

    const baseline = await store.readBaseline('unchanged')
    expect(baseline.image.toString()).toBe('stable')
    expect(baseline.meta).toEqual({ generation: 'stable' })
  })

  it('keeps identically named artifacts isolated by run id', async () => {
    await store.writeRunArtifact('runOne', 'current.png', new Blob(['one']))
    await store.writeRunArtifact('runTwo', 'current.png', new Uint8Array([116, 119, 111]))

    expect(await readFile(join(store.paths.runs, 'runOne', 'current.png'), 'utf8')).toBe('one')
    expect(await readFile(join(store.paths.runs, 'runTwo', 'current.png'), 'utf8')).toBe('two')
  })

  it('rejects traversal before touching the filesystem', async () => {
    await expect(store.writeRunArtifact('../escape', 'current.png', 'no'))
      .rejects.toMatchObject({ code: 'INVALID_PATH' })
    await expect(store.writeRunArtifact('safeRun', '../current.png', 'no'))
      .rejects.toMatchObject({ code: 'INVALID_PATH' })
    await expect(store.writeBaseline('../escape', { image: 'no', meta: {} }))
      .rejects.toMatchObject({ code: 'INVALID_PATH' })
  })

  it('commits successful and error terminal results', async () => {
    const ok = buildResult({
      runId: 'okRun',
      status: 'ok',
      operation: 'capture',
      name: 'dashboard'
    })
    const failed = buildErrorResult({
      runId: 'errorRun',
      operation: 'diff',
      name: 'dashboard',
      code: ERROR_CODES.BASELINE_NOT_FOUND,
      message: 'No baseline exists for dashboard'
    })

    await store.commitResult('okRun', ok)
    await store.commitResult('errorRun', failed)

    expect(await store.readResult('okRun')).toEqual(ok)
    expect(await store.readResult('errorRun')).toEqual(failed)
  })

  it('publishes exactly one complete terminal result under concurrent commits', async () => {
    const first = buildResult({
      runId: 'singleRun',
      status: 'ok',
      operation: 'capture',
      name: 'first'
    })
    const second = { ...first, name: 'second' }
    const restartedStore = createFsArtifactStore({ root })
    const attempts = await Promise.allSettled([
      store.commitResult('singleRun', first),
      restartedStore.commitResult('singleRun', second)
    ])

    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1)
    const rejected = attempts.find(attempt => attempt.status === 'rejected')
    expect(rejected.reason.code).toBe('RESULT_ALREADY_COMMITTED')
    expect([first, second]).toContainEqual(await store.readResult('singleRun'))
    expect((await readdir(join(store.paths.runs, 'singleRun')))
      .some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it('rejects malformed commits and never publishes their result file', async () => {
    const wrongRun = buildResult({
      runId: 'anotherRun',
      status: 'ok',
      operation: 'capture'
    })

    await expect(store.commitResult('expectedRun', wrongRun))
      .rejects.toMatchObject({ code: 'INVALID_RESULT' })
    expect(await store.readResult('expectedRun')).toBeNull()
  })

  it('reserves result.json for commitResult before and after terminal commit', async () => {
    await expect(store.writeRunArtifact('reservedRun', 'result.json', '{}'))
      .rejects.toMatchObject({ code: 'RESERVED_ARTIFACT' })
    await expect(store.writeRunArtifact('reservedRun', 'RESULT.JSON', '{}'))
      .rejects.toMatchObject({ code: 'RESERVED_ARTIFACT' })

    const result = buildResult({
      runId: 'reservedRun',
      status: 'ok',
      operation: 'capture'
    })
    await store.commitResult('reservedRun', result)

    await expect(store.writeRunArtifact('reservedRun', 'current.png', 'late'))
      .rejects.toMatchObject({ code: 'RUN_ALREADY_TERMINAL' })
    await expect(store.writeRunArtifact('reservedRun', 'result.json', '{}'))
      .rejects.toMatchObject({ code: 'RESERVED_ARTIFACT' })
    expect(await store.readResult('reservedRun')).toEqual(result)
  })

  it.skipIf(process.platform === 'win32')('refuses baseline reads through a symlink', async () => {
    const outside = join(sandbox, 'outside.png')
    await writeFile(outside, 'secret')
    await symlink(outside, join(store.paths.baselines, 'linked.png'))
    await writeFile(join(store.paths.baselines, 'linked.json'), '{}')

    await expect(store.readBaseline('linked')).rejects.toMatchObject({ code: 'INVALID_PATH' })
  })

  it.skipIf(process.platform === 'win32')('refuses writes through a symlinked runs directory', async () => {
    const outside = join(sandbox, 'outside-runs')
    await mkdir(outside)
    await rm(store.paths.runs, { recursive: true })
    await symlink(outside, store.paths.runs)

    await expect(store.writeRunArtifact('linkedRun', 'current.png', 'secret'))
      .rejects.toMatchObject({ code: 'INVALID_PATH' })
    await expect(access(join(outside, 'linkedRun', 'current.png'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.skipIf(process.platform === 'win32')('refuses a symlink configured as the artifact root', async () => {
    const outside = join(sandbox, 'outside-root')
    const linkedRoot = join(sandbox, 'linked-root')
    await mkdir(outside)
    await symlink(outside, linkedRoot)

    expect(() => createFsArtifactStore({ root: linkedRoot }))
      .toThrow(/unsafe path segment/)
  })
})
