/**
 * Run pruning — the only destructive operation in SnapEye.
 *
 * Rules it must never break:
 *   - it only ever deletes directories directly inside `<root>/runs/`;
 *   - it never touches `<root>/baselines/` (baselines are committable);
 *   - it never follows a symlink out of `runs/`;
 *   - it orders by a verifiable terminal date (`result.json.finishedAt`) and
 *     falls back to directory mtime.
 */
import { readdir, rm, lstat, open } from 'node:fs/promises'
import { constants as FS_CONSTANTS } from 'node:fs'
import { join } from 'node:path'
import { isValidRunId } from '../core/ids.js'
import { isInside } from './paths.js'

/**
 * @param {object} options
 * @param {string} options.runsDir absolute path of `<root>/runs`
 * @param {number} options.maxRuns how many of the newest runs to keep
 * @param {(msg: string) => void} [options.log]
 * @returns {Promise<{kept: string[], removed: string[]}>}
 */
export async function pruneRuns ({ runsDir, maxRuns, log } = {}) {
  const limit = Number.isFinite(maxRuns) ? Math.max(0, Math.floor(maxRuns)) : 0
  if (!await assertRunsRoot(runsDir)) return { kept: [], removed: [] }
  const entries = await readdir(runsDir, { withFileTypes: true })
  await assertRunsRoot(runsDir)

  const runs = []
  for (const entry of entries) {
    // Real directories only: a symlink named like a run is left alone.
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (!isValidRunId(entry.name)) continue
    const dir = join(runsDir, entry.name)
    if (!isInside(runsDir, dir)) continue
    const link = await lstat(dir).catch(() => null)
    if (!link || link.isSymbolicLink() || !link.isDirectory()) continue
    runs.push({ id: entry.name, dir, at: await terminalTime(dir) })
  }

  // Newest first; name as tie-break keeps the order stable within one mtime tick.
  runs.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1))

  const kept = runs.slice(0, limit)
  const doomed = runs.slice(limit)
  const removed = []

  for (const run of doomed) {
    await assertRunsRoot(runsDir)
    if (!isInside(runsDir, run.dir)) continue
    const current = await lstat(run.dir).catch(() => null)
    if (!current || current.isSymbolicLink() || !current.isDirectory()) continue
    await rm(run.dir, { recursive: true, force: true })
    removed.push(run.id)
  }

  if (removed.length && log) {
    log(`pruned ${removed.length} run(s), kept ${kept.length}/${limit}`)
  }
  return { kept: kept.map(r => r.id), removed }
}

/**
 * Prefer the run's own terminal timestamp — it survives a checkout or a copy
 * that rewrites mtimes — and fall back to the directory's mtime.
 */
async function terminalTime (dir) {
  const directory = await lstat(dir).catch(() => null)
  if (!directory || directory.isSymbolicLink() || !directory.isDirectory()) return 0

  let handle
  try {
    handle = await open(
      join(dir, 'result.json'),
      FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW || 0)
    )
    const resultStat = await handle.stat()
    if (!resultStat.isFile()) return directory.mtimeMs
    const result = JSON.parse(await handle.readFile({ encoding: 'utf8' }))
    const at = Date.parse(result?.finishedAt)
    if (Number.isFinite(at)) return at
  } catch {
    // no terminal result (crashed or in-flight run): fall through to mtime
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
  return directory.mtimeMs
}

async function assertRunsRoot (runsDir) {
  if (typeof runsDir !== 'string' || runsDir.length === 0) throw unsafeRunsRoot(runsDir)
  let stat
  try {
    stat = await lstat(runsDir)
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafeRunsRoot(runsDir)
  return true
}

function unsafeRunsRoot (value) {
  const err = new Error(`SnapEye refused unsafe runs root: ${JSON.stringify(String(value))}`)
  err.code = 'INVALID_PATH'
  return err
}
