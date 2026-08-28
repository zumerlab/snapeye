/**
 * Filesystem implementation of the SnapEye artifact store.
 *
 * This is the only module that writes artifacts to disk. The in-page runtime
 * never sees a path: it calls the same four methods over HTTP, and a future
 * Tauri/Electron adapter can implement them against the local filesystem or an
 * IPC channel without capture/diff/record changing at all.
 *
 *   interface ArtifactStore {
 *     readBaseline(name): Promise<StoredBaseline | null>
 *     writeBaseline(name, baseline): Promise<void>
 *     writeRunArtifact(runId, filename, data): Promise<void>
 *     commitResult(runId, result): Promise<void>
 *   }
 *
 * `commitResult()` publishes `result.json` atomically and is always the last
 * write of a run, so an agent that sees the file sees a finished run.
 */
import { mkdir, writeFile, rename, rm, open, link, lstat } from 'node:fs/promises'
import { constants as FS_CONSTANTS } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { LAYOUT } from '../core/protocol.js'
import { validateResult } from '../core/result.js'
import { resolveRoot, safeJoin, runPath, baselinePath, assertNoSymlinkEscape } from './paths.js'

const BASELINE_COMMIT_KEY = '__snapeyeBaselineCommit'
const BASELINE_COMMIT_FORMAT = 'snapeye-baseline-v1'
// Store instances can be recreated during Vite restarts. Keying locks by the
// absolute metadata path keeps replacements serialized across those instances
// while still allowing different baseline names to proceed independently.
const baselineLocksByPath = new Map()
const runLocksByResultPath = new Map()

/**
 * @param {object} options
 * @param {string} options.root artifact root (absolute, or relative to cwd)
 * @param {string} [options.cwd]
 * @returns {object} an ArtifactStore plus a few node-only helpers
 */
export function createFsArtifactStore ({ root, cwd = process.cwd() } = {}) {
  const rootAbs = resolveRoot(root, cwd)
  const baselinesAbs = safeJoin(rootAbs, LAYOUT.baselines)
  const runsAbs = safeJoin(rootAbs, LAYOUT.runs)
  assertNoSymlinkEscape(rootAbs, rootAbs)

  async function ensureLayout () {
    await ensureSafeDirectory(rootAbs, rootAbs)
    await ensureSafeDirectory(rootAbs, baselinesAbs)
    await ensureSafeDirectory(rootAbs, runsAbs)
  }

  async function readBaseline (name) {
    const png = baselinePath(rootAbs, LAYOUT.baselines, name, '.png')
    const meta = baselinePath(rootAbs, LAYOUT.baselines, name, '.json')
    return withKeyLock(baselineLocksByPath, meta, async () => {
      const serialized = await readFileSafeOrNull(rootAbs, meta, 'utf8')
      const stored = parseStoredBaselineMetadata(serialized, name)

      if (stored.commit && stored.commit.state !== 'committed') {
        throw baselineIntegrityError(name, 'replacement did not reach its commit marker')
      }

      const image = await readFileSafeOrNull(rootAbs, png)
      if (!image) {
        if (stored.commit) throw baselineIntegrityError(name, 'committed image is missing')
        return null
      }

      // Metadata is the commit marker. Reading it twice prevents a legacy pair
      // from being combined when another process starts upgrading it between
      // the first metadata read and the PNG read.
      const confirmed = await readFileSafeOrNull(rootAbs, meta, 'utf8')
      if (confirmed !== serialized) {
        throw baselineIntegrityError(name, 'metadata changed while the image was being read')
      }

      if (stored.commit) verifyBaselineImage(name, image, stored.commit)
      return { name, image, meta: stored.meta }
    })
  }

  async function writeBaseline (name, baseline) {
    const png = baselinePath(rootAbs, LAYOUT.baselines, name, '.png')
    const metaPath = baselinePath(rootAbs, LAYOUT.baselines, name, '.json')
    return withKeyLock(baselineLocksByPath, metaPath, async () => {
      const image = await toBytes(baseline.image)
      const generation = randomUUID()
      const metadata = prepareBaselineMetadata(baseline.meta, image, generation)

      await ensureSafeParent(rootAbs, png)
      assertNoSymlinkEscape(rootAbs, metaPath)

      // Invalidate any previous pair first. This matters when upgrading a
      // legacy baseline: if either following write fails, readers see a
      // pending marker instead of accepting a new PNG with old metadata.
      await writeFileAtomic(metaPath, serializeBaselineMetadata({
        [BASELINE_COMMIT_KEY]: {
          format: BASELINE_COMMIT_FORMAT,
          state: 'pending',
          generation
        }
      }), { rootAbs })
      await writeFileAtomic(png, image, { rootAbs })
      // Publishing committed metadata last makes it the pair's commit marker.
      await writeFileAtomic(metaPath, metadata, { rootAbs })
    })
  }

  async function writeRunArtifact (runId, filename, data) {
    if (typeof filename === 'string' && filename.toLowerCase() === 'result.json') {
      const err = new Error('SnapEye result.json can only be published through commitResult()')
      err.code = 'RESERVED_ARTIFACT'
      throw err
    }
    const resultFile = runPath(rootAbs, LAYOUT.runs, runId, 'result.json')
    return withKeyLock(runLocksByResultPath, resultFile, async () => {
      await assertRunOpen(rootAbs, resultFile, runId)
      const file = runPath(rootAbs, LAYOUT.runs, runId, filename)
      await ensureSafeParent(rootAbs, file)
      await writeFileAtomic(file, data, { rootAbs })
    })
  }

  async function commitResult (runId, result) {
    const problem = validateResult(result, runId)
    if (problem) {
      const err = new Error(`SnapEye refused an invalid result: ${problem}`)
      err.code = 'INVALID_RESULT'
      throw err
    }
    const file = runPath(rootAbs, LAYOUT.runs, runId, 'result.json')
    return withKeyLock(runLocksByResultPath, file, async () => {
      await ensureSafeParent(rootAbs, file)
      try {
        await writeFileAtomicOnce(file, JSON.stringify(result, null, 2) + '\n', { rootAbs })
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
        const committed = new Error(`SnapEye run ${runId} already has a terminal result`)
        committed.code = 'RESULT_ALREADY_COMMITTED'
        throw committed
      }
    })
  }

  async function readResult (runId) {
    const file = runPath(rootAbs, LAYOUT.runs, runId, 'result.json')
    try {
      return JSON.parse(await readFileSafe(rootAbs, file, 'utf8'))
    } catch (err) {
      if (err.code === 'ENOENT') return null
      throw err
    }
  }

  return {
    // ArtifactStore contract
    readBaseline,
    writeBaseline,
    writeRunArtifact,
    commitResult,
    // node-only helpers
    readResult,
    ensureLayout,
    paths: { root: rootAbs, baselines: baselinesAbs, runs: runsAbs }
  }
}

async function assertRunOpen (rootAbs, resultFile, runId) {
  assertNoSymlinkEscape(rootAbs, resultFile)
  try {
    const result = await lstat(resultFile)
    if (result) {
      const error = new Error(`SnapEye run ${runId} is already terminal`)
      error.code = 'RUN_ALREADY_TERMINAL'
      throw error
    }
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
}

function withKeyLock (locks, key, work) {
  const previous = locks.get(key) || Promise.resolve()
  const current = previous.catch(() => {}).then(work)
  locks.set(key, current)
  return current.finally(() => {
    if (locks.get(key) === current) locks.delete(key)
  })
}

function prepareBaselineMetadata (meta, image, generation) {
  if (meta != null && (!isPlainObject(meta))) {
    const error = new TypeError('SnapEye baseline metadata must be an object')
    error.code = 'INVALID_BASELINE_METADATA'
    throw error
  }

  const publicMeta = meta ?? {}
  const hadCommitKey = Object.prototype.hasOwnProperty.call(publicMeta, BASELINE_COMMIT_KEY)
  const commit = {
    format: BASELINE_COMMIT_FORMAT,
    state: 'committed',
    generation,
    image: {
      algorithm: 'sha256',
      digest: createHash('sha256').update(image).digest('hex'),
      byteLength: image.byteLength
    }
  }
  if (hadCommitKey) {
    commit.publicMetadata = { hadCommitKey: true, value: publicMeta[BASELINE_COMMIT_KEY] }
  }

  return serializeBaselineMetadata({ ...publicMeta, [BASELINE_COMMIT_KEY]: commit })
}

function serializeBaselineMetadata (metadata) {
  return JSON.stringify(metadata, null, 2) + '\n'
}

function parseStoredBaselineMetadata (serialized, name) {
  if (serialized == null) return { meta: null, commit: null }

  let parsed
  try {
    parsed = JSON.parse(serialized)
  } catch {
    // Preserve compatibility with a legacy PNG whose sidecar is malformed.
    // The runtime will reject the null metadata as incompatible.
    return { meta: null, commit: null }
  }

  if (!isPlainObject(parsed)) return { meta: parsed, commit: null }
  const candidate = parsed[BASELINE_COMMIT_KEY]
  if (!isPlainObject(candidate) || candidate.format !== BASELINE_COMMIT_FORMAT) {
    return { meta: parsed, commit: null }
  }
  if (candidate.state === 'pending') return { meta: null, commit: candidate }
  if (candidate.state !== 'committed' || !isValidBaselineCommit(candidate)) {
    throw baselineIntegrityError(name, 'commit marker is malformed')
  }

  const publicMeta = { ...parsed }
  delete publicMeta[BASELINE_COMMIT_KEY]
  if (candidate.publicMetadata?.hadCommitKey === true) {
    publicMeta[BASELINE_COMMIT_KEY] = candidate.publicMetadata.value
  }
  return { meta: publicMeta, commit: candidate }
}

function isValidBaselineCommit (commit) {
  return typeof commit.generation === 'string' && commit.generation.length > 0 &&
    isPlainObject(commit.image) && commit.image.algorithm === 'sha256' &&
    typeof commit.image.digest === 'string' && /^[a-f0-9]{64}$/.test(commit.image.digest) &&
    Number.isSafeInteger(commit.image.byteLength) && commit.image.byteLength >= 0
}

function verifyBaselineImage (name, image, commit) {
  const actualDigest = createHash('sha256').update(image).digest('hex')
  if (image.byteLength !== commit.image.byteLength || actualDigest !== commit.image.digest) {
    throw baselineIntegrityError(name, 'image does not match its commit marker')
  }
}

function baselineIntegrityError (name, reason) {
  const error = new Error(`SnapEye baseline ${JSON.stringify(name)} failed integrity validation: ${reason}`)
  error.code = 'BASELINE_INTEGRITY'
  return error
}

function isPlainObject (value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Write via a sibling temp file + rename. A reader either sees the previous
 * file or the complete new one — never a half-written artifact. The temp name
 * ends in `.tmp`, which the identifier rules make unaddressable from a request
 * and `.snapeye/.gitignore` ignores.
 */
export async function writeFileAtomic (file, data, { rootAbs } = {}) {
  const tmp = join(dirname(file), `.${randomUUID()}.tmp`)
  const bytes = await toBytes(data)
  try {
    if (rootAbs) {
      assertNoSymlinkEscape(rootAbs, file)
      assertNoSymlinkEscape(rootAbs, tmp)
    }
    await writeFile(tmp, bytes, { flag: 'wx' })
    if (rootAbs) assertNoSymlinkEscape(rootAbs, file)
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

async function writeFileAtomicOnce (file, data, { rootAbs } = {}) {
  const tmp = join(dirname(file), `.${randomUUID()}.tmp`)
  const bytes = await toBytes(data)
  try {
    if (rootAbs) {
      assertNoSymlinkEscape(rootAbs, file)
      assertNoSymlinkEscape(rootAbs, tmp)
    }
    await writeFile(tmp, bytes, { flag: 'wx' })
    if (rootAbs) assertNoSymlinkEscape(rootAbs, file)
    // A hard link publishes the fully-written temp inode under `result.json`
    // only when that name does not already exist. Unlike rename(), this gives
    // concurrent/restarted committers an atomic no-overwrite guarantee.
    await link(tmp, file)
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

async function ensureSafeParent (rootAbs, file) {
  assertNoSymlinkEscape(rootAbs, file)
  await ensureSafeDirectory(rootAbs, dirname(file))
  assertNoSymlinkEscape(rootAbs, file)
}

async function ensureSafeDirectory (rootAbs, directory) {
  assertNoSymlinkEscape(rootAbs, directory)
  await mkdir(directory, { recursive: true })
  assertNoSymlinkEscape(rootAbs, directory)
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafePath(directory)
}

async function readFileSafe (rootAbs, file, encoding) {
  assertNoSymlinkEscape(rootAbs, file)
  let handle
  try {
    handle = await open(file, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW || 0))
  } catch (err) {
    if (err.code === 'ELOOP') throw unsafePath(file)
    throw err
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw unsafePath(file)
    return encoding ? await handle.readFile({ encoding }) : await handle.readFile()
  } finally {
    await handle.close()
  }
}

async function readFileSafeOrNull (rootAbs, file, encoding) {
  try {
    return await readFileSafe(rootAbs, file, encoding)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function toBytes (data) {
  if (data == null) return Buffer.alloc(0)
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (isBlob(data)) {
    return Buffer.from(await data.arrayBuffer())
  }
  throw new TypeError('SnapEye artifact data must be a Blob, string, Buffer, Uint8Array or ArrayBuffer')
}

function isBlob (value) {
  if (!value || typeof value.arrayBuffer !== 'function') return false
  if (typeof globalThis.Blob === 'function' && value instanceof globalThis.Blob) return true
  // A Blob crossing a window/worker realm does not satisfy `instanceof` in
  // this realm, but retains the standard brand and arrayBuffer contract.
  return Object.prototype.toString.call(value) === '[object Blob]'
}

function unsafePath (value) {
  const err = new Error(`SnapEye refused an unsafe filesystem path: ${JSON.stringify(String(value))}`)
  err.code = 'INVALID_PATH'
  return err
}
