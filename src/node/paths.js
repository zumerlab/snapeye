/**
 * Path safety for everything that touches the filesystem.
 *
 * SnapEye is a dev tool, but it writes files on behalf of whatever opened a
 * URL, so the rule is absolute: a request may only name *segments*, never
 * paths. Segments are validated against the shared identifier rules, joined
 * onto the configured root, and the result is re-checked to be inside it.
 */
import { resolve, join, sep, relative, isAbsolute } from 'node:path'
import { lstatSync } from 'node:fs'
import { isValidRunId, isValidName, isValidFilename } from '../core/ids.js'

/** Absolute artifact root, resolved against `cwd` when relative. */
export function resolveRoot (root, cwd = process.cwd()) {
  if (typeof root !== 'string' || root.length === 0) throw invalidPath(root)
  if (typeof cwd !== 'string' || cwd.length === 0) throw invalidPath(cwd)
  return isAbsolute(root) ? resolve(root) : resolve(cwd, root)
}

/** True when `target` is the root itself or lives inside it. */
export function isInside (rootAbs, target) {
  const rel = relative(rootAbs, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Join validated segments onto the root.
 * @throws {Error} with `code = 'INVALID_PATH'` when anything looks unsafe
 */
export function safeJoin (rootAbs, ...segments) {
  for (const segment of segments) {
    if (typeof segment !== 'string' || segment.length === 0) throw invalidPath(segment)
    if (segment === '.' || segment === '..') throw invalidPath(segment)
    if (segment.includes('/') || segment.includes('\\')) throw invalidPath(segment)
    if (isAbsolute(segment)) throw invalidPath(segment)
  }
  const target = resolve(join(rootAbs, ...segments))
  if (!isInside(rootAbs, target)) throw invalidPath(segments.join('/'))
  return target
}

/** Validated run directory path. */
export function runPath (rootAbs, runsDir, runId, ...rest) {
  if (!isValidRunId(runId)) throw invalidPath(runId)
  for (const part of rest) {
    if (!isValidFilename(part)) throw invalidPath(part)
  }
  return safeJoin(rootAbs, runsDir, runId, ...rest)
}

/** Validated baseline file path. */
export function baselinePath (rootAbs, baselinesDir, name, extension) {
  if (!isValidName(name)) throw invalidPath(name)
  return safeJoin(rootAbs, baselinesDir, `${name}${extension}`)
}

/**
 * Refuse to follow a symlink anywhere between the root and `target`.
 * Cheap (a handful of lstat calls) and closes the "point runs/x at ~/.ssh"
 * hole without needing realpath on files that do not exist yet.
 */
export function assertNoSymlinkEscape (rootAbs, target) {
  if (!isAbsolute(rootAbs) || !isAbsolute(target)) throw invalidPath(target)
  if (!isInside(rootAbs, target)) throw invalidPath(target)

  // The configured artifact root itself is part of the trust boundary. A
  // symlink at `.snapeye` would make every lexically-safe child path point
  // somewhere else before we even inspect the relative components.
  const rootStat = lstatIfExists(rootAbs)
  if (rootStat?.isSymbolicLink() || (rootStat && !rootStat.isDirectory())) {
    throw invalidPath(rootAbs)
  }

  let current = rootAbs
  const rel = relative(rootAbs, target)
  if (!rel) return
  for (const part of rel.split(sep)) {
    current = join(current, part)
    const stat = lstatIfExists(current)
    if (!stat) return // does not exist yet: descendants cannot exist either
    if (stat.isSymbolicLink()) throw invalidPath(current)
  }
}

function lstatIfExists (path) {
  try {
    return lstatSync(path)
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null
    throw err
  }
}

function invalidPath (value) {
  const err = new Error(`SnapEye refused an unsafe path segment: ${JSON.stringify(String(value))}`)
  err.code = 'INVALID_PATH'
  return err
}
