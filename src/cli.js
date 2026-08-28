#!/usr/bin/env node
/**
 * `snapeye` — the whole agent handshake as one command.
 *
 * The protocol underneath is five steps: check health, mint a run id, open the
 * trigger URL, poll for `.snapeye/runs/<runId>/result.json`, read `status`.
 * Every agent can do that, and every agent writes the polling loop slightly
 * differently — usually wrong, always expensively. So it lives here instead:
 *
 *   $ snapeye diff dashboard --target '#dashboard'
 *   { "status": "ok", "diff": { "changed": false, ... } }
 *
 * The result JSON goes to stdout and nothing else does, so `| jq` works.
 * Progress and diagnostics go to stderr. The exit code answers the question
 * without parsing anything:
 *
 *   0  terminal result with status "ok"
 *   1  terminal result with status "error"
 *   2  the environment is wrong (no dev server, no plugin, timed out)
 *   3  --fail-on-change and the diff reported a change
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { PROTOCOL_VERSION, TRIGGER_PARAM } from './core/protocol.js'
import { generateRunId, isValidName, isValidRunId } from './core/ids.js'
import { ensureAgentDoc } from './node/agent-doc.js'

const OPERATIONS = new Set(['capture', 'diff', 'record'])
const DEFAULT_URL = process.env.SNAPEYE_URL || 'http://localhost:5173'
const DEFAULT_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 100

const USAGE = `snapeye — capture, compare, and record from a running dev server

Usage
  snapeye capture <name> [options]
  snapeye diff    <name> [options]
  snapeye record  <name> [options]
  snapeye init                        teach your coding agent to use SnapEye

Options
  --url <url>          page to trigger on (default ${DEFAULT_URL})
  --target <selector>  CSS selector to capture (default: the page)
  --run <id>           run id (default: generated)
  --root <dir>         artifact root (default: reported by /__snapeye/health)
  --timeout <ms>       how long to wait for the terminal result (default ${DEFAULT_TIMEOUT_MS})
  --wait <ms|selector> hold the capture until this delay or selector is ready
  --no-stabilize       do not pin animations before capturing
  --no-open            print the URL instead of opening it, then wait for it
  --open-with <cmd>    command used to open the URL
  --fail-on-change     exit 3 when a diff reports a change
  --duration <ms>      record only (default 3000)
  --fps <n>            record only (default 10)
  --format <fmt>       record only: gif | video | both (default gif)
  --scale <n>          record only (default 1)
  --file <path>        init only: instructions file to update
  -h, --help           show this message

Exit codes
  0 status "ok"   1 status "error"   2 environment problem   3 diff changed
`

/** @param {string[]} argv */
export async function main (argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    return fail(2, error.message, USAGE)
  }
  if (options.help) {
    process.stdout.write(USAGE)
    return 0
  }

  if (options.command === 'init') return await runInit(options)

  const health = await readHealth(options.origin)
  if (!health.ok) {
    return fail(
      2,
      `SnapEye is not answering at ${options.origin}/__snapeye/health (${health.reason}).`,
      'Start the dev server and make sure snapeye() is in the Vite plugins.'
    )
  }
  if (health.body.protocolVersion !== PROTOCOL_VERSION) {
    note(`warning: server speaks protocol ${health.body.protocolVersion}, this CLI speaks ${PROTOCOL_VERSION}`)
  }

  const artifactRoot = resolveArtifactRoot(options.root, health.body)
  const resultFile = join(artifactRoot, 'runs', options.runId, 'result.json')
  const triggerUrl = buildTriggerUrl(options)

  if (options.open) {
    note(`opening ${triggerUrl}`)
    openUrl(triggerUrl, options.openWith)
  } else {
    note('open this URL to run the operation:')
    note(triggerUrl)
  }

  const result = await pollForResult(resultFile, options.timeout)
  if (!result) {
    return fail(
      2,
      `Timed out after ${options.timeout}ms waiting for ${resultFile}.`,
      'The page never reached a terminal result: the SnapEye client may not have loaded, or the URL never opened.'
    )
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (result.status !== 'ok') return 1
  if (options.failOnChange && result.diff?.changed === true) return 3
  return 0
}

/**
 * Write the agent instructions. This is the step that decides whether SnapEye
 * gets used at all: without it the agent does the task, verifies nothing, and
 * reports that it looks fine.
 */
async function runInit (options) {
  let results
  try {
    results = await ensureAgentDoc(process.cwd(), { file: options.file })
  } catch (error) {
    return fail(2, `Could not update the agent instructions: ${error.message}`)
  }

  for (const result of results) {
    const path = relative(process.cwd(), result.path) || result.path
    if (result.action === 'skipped') note(`left ${path} alone — ${result.reason}`)
    else if (result.action === 'unchanged') note(`${path} is already up to date`)
    else note(`${result.action} the SnapEye section in ${path}`)
  }
  if (results.some(result => result.action === 'created' || result.action === 'appended')) {
    note('commit that file so every agent working in this repo gets the instructions')
  }
  return 0
}

function parseArgs (argv) {
  const options = {
    operation: null,
    name: null,
    url: DEFAULT_URL,
    target: null,
    runId: null,
    root: null,
    timeout: DEFAULT_TIMEOUT_MS,
    waitFor: null,
    stabilize: true,
    open: true,
    openWith: null,
    file: null,
    failOnChange: false,
    record: {},
    help: false
  }
  const positional = []

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    const next = () => {
      const value = argv[++index]
      if (value === undefined) throw new Error(`${argument} needs a value`)
      return value
    }

    switch (argument) {
      case '-h': case '--help': options.help = true; break
      case '--url': options.url = next(); break
      case '--target': options.target = next(); break
      case '--run': options.runId = next(); break
      case '--root': options.root = next(); break
      case '--timeout': options.timeout = positiveInteger(next(), '--timeout'); break
      case '--wait': options.waitFor = next(); break
      case '--no-stabilize': options.stabilize = false; break
      case '--no-open': options.open = false; break
      case '--open-with': options.openWith = next(); break
      case '--file': options.file = next(); break
      case '--fail-on-change': options.failOnChange = true; break
      case '--duration': options.record.duration = positiveInteger(next(), '--duration'); break
      case '--fps': options.record.fps = next(); break
      case '--format': options.record.format = next(); break
      case '--scale': options.record.scale = next(); break
      default:
        if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`)
        positional.push(argument)
    }
  }

  if (options.help) return options

  const [operation, name] = positional
  if (operation === 'init') {
    if (positional.length > 1) throw new Error('init takes no positional arguments')
    return { ...options, command: 'init' }
  }
  if (!operation) throw new Error('An operation is required: capture, diff, record, or init')
  if (!OPERATIONS.has(operation)) throw new Error(`Unknown operation: ${operation}`)
  if (!name) throw new Error(`${operation} needs a name`)
  if (!isValidName(name)) {
    throw new Error(`Invalid name: ${name}. Use 1-64 chars of [A-Za-z0-9._-] starting with a letter or digit.`)
  }
  if (positional.length > 2) throw new Error(`Unexpected argument: ${positional[2]}`)

  options.operation = operation
  options.name = name
  options.runId = options.runId || generateRunId()
  if (!isValidRunId(options.runId)) {
    throw new Error(`Invalid run id: ${options.runId}. Use 1-64 chars of [A-Za-z0-9_-].`)
  }

  let parsed
  try {
    parsed = new URL(options.url)
  } catch {
    throw new Error(`Invalid --url: ${options.url}`)
  }
  options.origin = parsed.origin
  options.pageUrl = parsed
  return options
}

function buildTriggerUrl (options) {
  const url = new URL(options.pageUrl)
  url.searchParams.set(TRIGGER_PARAM, options.operation)
  url.searchParams.set('name', options.name)
  url.searchParams.set('run', options.runId)
  if (options.target) url.searchParams.set('target', options.target)
  if (options.waitFor != null) url.searchParams.set('wait', options.waitFor)
  if (!options.stabilize) url.searchParams.set('stabilize', '0')
  for (const [key, value] of Object.entries(options.record)) {
    if (value != null) url.searchParams.set(key, String(value))
  }
  return url.href
}

async function readHealth (origin) {
  let response
  try {
    response = await fetch(new URL('/__snapeye/health', origin))
  } catch (error) {
    return { ok: false, reason: error?.cause?.code || error?.message || 'unreachable' }
  }
  if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
  try {
    const body = await response.json()
    if (body?.status !== 'ok') return { ok: false, reason: 'unexpected health payload' }
    return { ok: true, body }
  } catch {
    return { ok: false, reason: 'health did not return JSON' }
  }
}

/**
 * `artifactRoot` from health is the configured value, which is relative to
 * Vite's project root — not necessarily this process's cwd. Prefer the
 * absolute one the server resolved.
 */
function resolveArtifactRoot (override, health) {
  if (override) return resolve(process.cwd(), override)
  const reported = health.artifactRootResolved || health.artifactRoot
  if (typeof reported !== 'string' || reported === '') return resolve(process.cwd(), '.snapeye')
  return isAbsolute(reported) ? reported : resolve(process.cwd(), reported)
}

async function pollForResult (file, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      // The result file is published atomically and only once, so reading it
      // successfully means the run is terminal. No partial read is possible.
      return JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    if (Date.now() >= deadline) return null
    await sleep(POLL_INTERVAL_MS)
  }
}

function openUrl (url, openWith) {
  const [command, ...args] = openWith
    ? [...openWith.split(' '), url]
    : process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', error => note(`could not open a browser (${error.message}); open the URL manually`))
    child.unref()
  } catch (error) {
    note(`could not open a browser (${error.message}); open the URL manually`)
  }
}

function positiveInteger (value, label) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`)
  return number
}

function sleep (milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function note (line) {
  process.stderr.write(`snapeye: ${line}\n`)
}

function fail (code, message, hint) {
  note(message)
  // Multi-line hints (the usage block) are written verbatim: prefixing every
  // line of it turns help into noise.
  if (hint) process.stderr.write(hint.includes('\n') ? `\n${hint}` : `snapeye: ${hint}\n`)
  return code
}

const invokedDirectly = process.argv[1] && (
  process.argv[1].endsWith('cli.js') ||
  process.argv[1].endsWith('snapeye') ||
  process.argv[1].endsWith('snapeye.cmd')
)

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2))
}

export { buildTriggerUrl, parseArgs, resolveArtifactRoot, USAGE }
