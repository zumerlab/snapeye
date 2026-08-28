/**
 * `.snapeye/.gitignore` maintenance.
 *
 * `runs/` is throwaway; `baselines/` is not — they are the committable record
 * that makes branch-to-branch comparison possible later. If the file already
 * exists it belongs to the user: we only append the entries that are missing,
 * never rewrite or reorder what is there.
 */
import { mkdir, open } from 'node:fs/promises'
import { constants as FS_CONSTANTS } from 'node:fs'
import { join } from 'node:path'
import { GITIGNORE_ENTRIES } from '../core/protocol.js'
import { writeFileAtomic } from './fs-store.js'
import { assertNoSymlinkEscape } from './paths.js'

const HEADER = [
  '# Created by @zumer/snapeye.',
  '# Runs are disposable; baselines are meant to be committed.'
]

/**
 * @param {string} rootAbs absolute artifact root
 * @param {string[]} [entries] entries that must be present
 * @returns {Promise<{created: boolean, added: string[], path: string}>}
 */
export async function ensureGitignore (rootAbs, entries = GITIGNORE_ENTRIES) {
  const path = join(rootAbs, '.gitignore')
  assertNoSymlinkEscape(rootAbs, rootAbs)
  await mkdir(rootAbs, { recursive: true })
  assertNoSymlinkEscape(rootAbs, rootAbs)
  assertNoSymlinkEscape(rootAbs, path)

  let existing = null
  try {
    existing = await readGitignore(rootAbs, path)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  if (existing == null) {
    await writeFileAtomic(path, [...HEADER, ...entries].join('\n') + '\n', { rootAbs })
    return { created: true, added: [...entries], path }
  }

  const present = new Set(
    existing.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  )
  const missing = entries.filter(entry => !present.has(entry))
  if (!missing.length) return { created: false, added: [], path }

  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
  await writeFileAtomic(path, existing + separator + missing.join('\n') + '\n', { rootAbs })
  return { created: false, added: missing, path }
}

async function readGitignore (rootAbs, path) {
  assertNoSymlinkEscape(rootAbs, path)
  let handle
  try {
    handle = await open(path, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW || 0))
  } catch (err) {
    if (err.code === 'ELOOP') throw unsafePath(path)
    throw err
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw unsafePath(path)
    return await handle.readFile({ encoding: 'utf8' })
  } finally {
    await handle.close()
  }
}

function unsafePath (value) {
  const err = new Error(`SnapEye refused unsafe .gitignore path: ${JSON.stringify(String(value))}`)
  err.code = 'INVALID_PATH'
  return err
}
