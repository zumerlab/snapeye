/**
 * Identifier validation — the only gate between an agent-supplied string and
 * the filesystem. Shared by the in-page runtime (fail fast, loud console) and
 * the middleware (reject the request), so both agree on what is legal.
 *
 * Rules, deliberately narrow:
 *   - `[A-Za-z0-9_-]`, 1..64 chars for a runId.
 *   - `[A-Za-z0-9._-]`, 1..64 chars for a baseline name, no leading dot.
 *   - Artifact filenames are one path segment from a known-safe alphabet.
 * No slashes, no `..`, no control characters, no absolute paths — ever.
 */

export const MAX_ID_LENGTH = 64

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** True when `value` is a legal runId. */
export function isValidRunId (value) {
  return typeof value === 'string' && RUN_ID_RE.test(value) && !hasTraversal(value)
}

/** True when `value` is a legal baseline name (also used for run artifacts). */
export function isValidName (value) {
  return typeof value === 'string' && NAME_RE.test(value) && !hasTraversal(value)
}

/** True when `value` is a legal single-segment artifact filename. */
export function isValidFilename (value) {
  if (typeof value !== 'string' || !FILENAME_RE.test(value)) return false
  if (hasTraversal(value)) return false
  // Guard against `foo.` / `foo.tmp` names that would collide with the
  // temporary files used by atomic writes.
  return !value.endsWith('.') && !value.endsWith('.tmp')
}

/** ASCII control characters are never legal inside an identifier. */
function hasControlChars (value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function hasTraversal (value) {
  return value === '.' || value === '..' || value.includes('..') ||
    value.includes('/') || value.includes('\\') || hasControlChars(value)
}

/**
 * Coerce an arbitrary string into a legal name. Used only where a *fallback*
 * is safe — never to rescue an invalid runId, which must fail loudly.
 */
export function sanitizeName (value, fallback = 'snap') {
  const cleaned = String(value ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, MAX_ID_LENGTH)
  return isValidName(cleaned) ? cleaned : fallback
}

/**
 * Generate a client-side runId when the JavaScript API is called without one.
 * Time-ordered prefix + random suffix: sortable in a directory listing and
 * collision-free enough for a dev server.
 */
export function generateRunId (now = Date.now(), random = Math.random) {
  const stamp = Number(now).toString(36).padStart(9, '0').slice(-9)
  let suffix = ''
  for (let i = 0; i < 6; i++) suffix += Math.floor(random() * 36).toString(36)
  return `r${stamp}${suffix}`
}

/** Throw a coded error when the runId is unusable. */
export function assertRunId (value) {
  if (!isValidRunId(value)) {
    const err = new Error(
      `Invalid SnapEye run id: ${JSON.stringify(value)}. ` +
      'Use 1-64 chars of [A-Za-z0-9_-].'
    )
    err.code = 'INVALID_RUN_ID'
    throw err
  }
  return value
}

/** Throw a coded error when the name is unusable. */
export function assertName (value) {
  if (!isValidName(value)) {
    const err = new Error(
      `Invalid SnapEye name: ${JSON.stringify(value)}. ` +
      'Use 1-64 chars of [A-Za-z0-9._-] starting with a letter or digit.'
    )
    err.code = 'INVALID_NAME'
    throw err
  }
  return value
}
