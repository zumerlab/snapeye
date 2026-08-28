/**
 * Agent instructions — the actual installation step.
 *
 * An agent does not discover SnapEye by finding it in `package.json`. Even if
 * it did, the part that matters is not "a tool exists" but the discipline:
 * capture the baseline BEFORE editing, read `status` before opening any image,
 * never re-capture a baseline to make a diff pass. An agent that learns about
 * SnapEye after it has already edited the code has lost the reference it needed.
 *
 * That discipline lives in `AGENTS.md` / `CLAUDE.md`, which every major coding
 * agent reads on its own. Without it the failure is silent: the agent does the
 * task, verifies nothing, and reports that it looks fine.
 *
 * The block is delimited so it can be updated in place later without touching a
 * single line the developer wrote around it.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from './fs-store.js'

const BEGIN = '<!-- snapeye:begin -->'
const END = '<!-- snapeye:end -->'

/** Files a coding agent reads by itself, in the order we prefer them. */
const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md']

const SNIPPET = `## Visual verification with SnapEye

Use \`npx snapeye\` to verify anything visual. It prints \`result.json\` to stdout.

\`\`\`sh
npx snapeye capture <name> --target '<css-selector>'   # record the reference
npx snapeye diff    <name> --target '<css-selector>'   # compare against it
npx snapeye record  <name> --target '<css-selector>' --duration 3000
\`\`\`

Add \`--url\` when the target is not on the dev server's home page.

Exit codes: 0 = ok, 1 = the run failed (read \`error.code\`), 2 = SnapEye or the
dev server is not running, 3 = \`--fail-on-change\` and the diff changed.

Rules:

1. Capture the baseline BEFORE editing. After the edit there is nothing to
   compare against.
2. Read \`status\` before anything else.
3. On \`diff.changed: false\` you are done. Do not open any image.
4. On \`diff.changed: true\`, use \`diff.regions\` to decide whether to open
   \`diff.png\`. Regions are CSS pixels from the top-left of the captured target.
5. Never re-capture a baseline just to make a diff pass. Replace a baseline only
   after reviewing the change and deciding it is correct.
6. Use a distinct name per component and viewport. Baselines are committed.
7. For a state that only exists after an interaction, drive the page with your
   browser tool and call \`window.snapeye.diff(name, selector)\` — it returns the
   result inline, with no run ID and no polling.
8. On exit code 2, report that the SnapEye environment is not running. Do not
   silently continue without visual verification.`

/** The block written into an agent instructions file, markers included. */
export const AGENT_BLOCK = `${BEGIN}\n${SNIPPET}\n${END}`

/**
 * Add or refresh the SnapEye block in the project's agent instructions.
 *
 * Never rewrites or reorders anything the developer wrote: the block is
 * appended, and on later runs only the text between the markers is replaced.
 *
 * @param {string} root project root
 * @param {{file?: string}} [options] explicit target instead of the defaults
 * @returns {Promise<Array<{path: string, action: string, reason?: string}>>}
 */
export async function ensureAgentDoc (root, { file } = {}) {
  const targets = file ? [join(root, file)] : await resolveTargets(root)
  const results = []
  for (const path of targets) {
    results.push(await ensureOne(path))
  }
  return results
}

/**
 * True when some agent instructions file already tells an agent about SnapEye.
 * Deliberately loose: a hand-written mention counts, because the point is
 * whether the agent will be told, not whether we wrote the words.
 */
export async function hasAgentDoc (root) {
  for (const name of await agentFilesIn(root)) {
    const content = await readIfPresent(join(root, name))
    if (content && /snapeye/i.test(content)) return true
  }
  return false
}

async function ensureOne (path) {
  const existing = await readIfPresent(path)

  if (existing == null) {
    await writeFileAtomic(path, `${AGENT_BLOCK}\n`)
    return { path, action: 'created' }
  }

  const begin = existing.indexOf(BEGIN)
  const end = existing.indexOf(END)
  if (begin !== -1 && end > begin) {
    const current = existing.slice(begin, end + END.length)
    if (current === AGENT_BLOCK) return { path, action: 'unchanged' }
    const updated = existing.slice(0, begin) + AGENT_BLOCK + existing.slice(end + END.length)
    await writeFileAtomic(path, updated)
    return { path, action: 'updated' }
  }

  // A copy that predates the markers, or instructions the developer wrote by
  // hand. Appending would duplicate them, and rewriting them is not ours to do.
  if (/snapeye/i.test(existing)) {
    return { path, action: 'skipped', reason: 'it already mentions SnapEye' }
  }

  const separator = existing.length === 0 || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  await writeFileAtomic(path, existing + separator + AGENT_BLOCK + '\n')
  return { path, action: 'appended' }
}

/** Existing agent files, or `AGENTS.md` to create when the project has none. */
async function resolveTargets (root) {
  const present = await agentFilesIn(root)
  if (present.length) return present.map(name => join(root, name))
  return [join(root, AGENT_FILES[0])]
}

/** Match case-insensitively: repositories spell these files several ways. */
async function agentFilesIn (root) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const wanted = new Map(AGENT_FILES.map(name => [name.toLowerCase(), name]))
  const found = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (wanted.has(entry.name.toLowerCase())) found.push(entry.name)
  }
  return found.sort((a, b) =>
    AGENT_FILES.indexOf(wanted.get(a.toLowerCase())) - AGENT_FILES.indexOf(wanted.get(b.toLowerCase())))
}

async function readIfPresent (path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
