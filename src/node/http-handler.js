/**
 * Secure Node/Connect HTTP transport for the SnapEye ArtifactStore contract.
 *
 * The browser may select a baseline name, run id, and one of the fixed V1
 * artifact filenames. It never sends a filesystem path. Every non-health
 * request is authenticated with the ephemeral token injected by the Vite
 * plugin.
 */
import { timingSafeEqual } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { decodeBaselineEnvelope, encodeBaselineEnvelope } from '../core/envelope.js'
import { ARTIFACTS, DEFAULTS, ERROR_CODES, PROTOCOL_VERSION } from '../core/protocol.js'
import { isValidName, isValidRunId } from '../core/ids.js'

const require = createRequire(import.meta.url)
const packageJson = require('../../package.json')

const BASELINE_TYPE = 'application/vnd.snapeye.baseline'
const JSON_TYPE = 'application/json'
const TEXT_TYPE = 'text/plain'

const ARTIFACT_TYPES = new Map([
  [ARTIFACTS.current, 'image/png'],
  [ARTIFACTS.diff, 'image/png'],
  [ARTIFACTS.frames, 'image/png'],
  [ARTIFACTS.gif, 'image/gif'],
  [ARTIFACTS.webm, 'video/webm'],
  [ARTIFACTS.mp4, 'video/mp4']
])

const ROUTES = new Set(['/health', '/baseline', '/artifact', '/result', '/log'])

/**
 * Create a middleware compatible with Node http and Connect/Vite.
 *
 * @param {object} options
 * @param {object} options.store ArtifactStore implementation
 * @param {string} options.token ephemeral write/read token
 * @param {string} [options.endpoint]
 * @param {number} [options.maxRequestBytes]
 * @param {string} [options.artifactRoot] display value returned by health
 * @param {string} [options.artifactRootResolved] absolute artifact root
 * @param {(line:string) => void} [options.log]
 */
export function createSnapEyeHttpHandler ({
  store,
  token,
  endpoint = DEFAULTS.endpoint,
  maxRequestBytes = DEFAULTS.maxRequestBytes,
  artifactRoot = DEFAULTS.root,
  artifactRootResolved = null,
  name = packageJson.name,
  version = packageJson.version,
  log = null
} = {}) {
  assertStore(store)
  if (typeof token !== 'string' || token.length < 16) {
    throw new TypeError('SnapEye HTTP transport requires an ephemeral token')
  }
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) {
    throw new TypeError('SnapEye maxRequestBytes must be a positive safe integer')
  }

  const base = normalizeEndpoint(endpoint)
  const committedRuns = new Set()
  const runQueues = new Map()

  return async function snapEyeHttpHandler (req, res, next) {
    let url
    try {
      url = new URL(req.url || '/', 'http://snapeye.local')
    } catch {
      if (!String(req.url || '').startsWith(base)) return pass(next)
      return sendError(res, requestError(400, 'INVALID_REQUEST', 'Invalid request URL'))
    }

    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) {
      return pass(next)
    }

    const route = url.pathname.slice(base.length)
    if (!ROUTES.has(route)) {
      discardBody(req)
      return sendError(res, requestError(404, 'NOT_FOUND', 'Unknown SnapEye endpoint'))
    }

    try {
      if (route === '/health') {
        requireMethod(req, ['GET'])
        return sendJson(res, 200, {
          status: 'ok',
          name,
          version,
          protocolVersion: PROTOCOL_VERSION,
          artifactRoot,
          // Additive since protocol 1: `artifactRoot` is the configured value,
          // which is relative to Vite's project root and therefore ambiguous
          // for a CLI invoked from anywhere else. This one never is.
          artifactRootResolved: artifactRootResolved || store?.paths?.root || null
        })
      }

      if (!hasToken(req, token)) {
        discardBody(req)
        throw requestError(401, 'UNAUTHORIZED', 'Invalid or missing SnapEye token')
      }

      if (route === '/baseline') {
        if (req.method === 'GET') {
          const baselineName = readName(url)
          await assertSafeBaselineFiles(store, baselineName)
          const baseline = await store.readBaseline(baselineName)
          if (baseline == null) return sendEmpty(res, 204)
          const body = await encodeBaselineEnvelope(baseline)
          return sendBytes(res, 200, BASELINE_TYPE, body)
        }

        requireMethod(req, ['GET', 'POST'])
        requireContentType(req, BASELINE_TYPE)
        const baselineName = readName(url)
        const body = await readBody(req, maxRequestBytes)
        let baseline
        try {
          baseline = decodeBaselineEnvelope(body)
        } catch {
          throw requestError(400, 'INVALID_BASELINE', 'Invalid SnapEye baseline payload')
        }
        if (!isPlainObject(baseline.meta)) {
          throw requestError(400, 'INVALID_BASELINE', 'SnapEye baseline metadata must be an object')
        }
        await assertSafeBaselineFiles(store, baselineName)
        await store.writeBaseline(baselineName, baseline)
        return sendEmpty(res, 204)
      }

      if (route === '/artifact') {
        requireMethod(req, ['POST'])
        const runId = readRunId(url)
        const filename = readArtifactFilename(url)
        requireContentType(req, ARTIFACT_TYPES.get(filename))
        await serializeRun(runQueues, runId, async () => {
          if (await isCommitted(store, committedRuns, runId)) {
            discardBody(req)
            throw requestError(409, 'RUN_ALREADY_COMMITTED', 'The SnapEye run already has a terminal result')
          }
          const body = await readBody(req, maxRequestBytes)
          await store.writeRunArtifact(runId, filename, body)
        })
        return sendEmpty(res, 204)
      }

      if (route === '/result') {
        requireMethod(req, ['POST'])
        requireContentType(req, JSON_TYPE)
        const runId = readRunId(url)
        await serializeRun(runQueues, runId, async () => {
          if (await isCommitted(store, committedRuns, runId)) {
            discardBody(req)
            throw requestError(409, 'RUN_ALREADY_COMMITTED', 'The SnapEye run already has a terminal result')
          }
          const body = await readBody(req, maxRequestBytes)
          let result
          try {
            result = JSON.parse(body.toString('utf8'))
          } catch {
            throw requestError(400, 'INVALID_RESULT', 'Invalid SnapEye result JSON')
          }
          try {
            await store.commitResult(runId, result)
            committedRuns.add(runId)
          } catch (error) {
            if (error?.code === 'RESULT_ALREADY_COMMITTED') {
              committedRuns.add(runId)
              throw requestError(409, 'RUN_ALREADY_COMMITTED', 'The SnapEye run already has a terminal result')
            }
            if (error?.code === 'INVALID_RESULT' || error?.code === 'INVALID_PATH') {
              throw requestError(400, 'INVALID_RESULT', 'Invalid SnapEye terminal result')
            }
            throw error
          }
        })
        return sendEmpty(res, 204)
      }

      requireMethod(req, ['POST'])
      requireContentType(req, TEXT_TYPE)
      const body = await readBody(req, Math.min(maxRequestBytes, 256 * 1024))
      if (typeof log === 'function') log(`[browser] ${body.toString('utf8')}`)
      return sendEmpty(res, 204)
    } catch (error) {
      discardBody(req)
      if (!(error instanceof RequestError) && typeof log === 'function') {
        log(`request failed: ${error?.message || String(error)}`)
      }
      return sendError(res, normalizeRequestError(error))
    }
  }
}

function assertStore (store) {
  const methods = ['readBaseline', 'writeBaseline', 'writeRunArtifact', 'commitResult']
  if (!store || methods.some(method => typeof store[method] !== 'function')) {
    throw new TypeError('SnapEye HTTP transport requires an ArtifactStore')
  }
}

function normalizeEndpoint (endpoint) {
  const value = String(endpoint || '').replace(/\/+$/, '')
  if (!value.startsWith('/') || value === '/' || value.includes('?') || value.includes('#')) {
    throw new TypeError('SnapEye endpoint must be an absolute URL pathname')
  }
  return value
}

function readName (url) {
  const name = singleParam(url, 'name', ERROR_CODES.INVALID_NAME, 'A valid baseline name is required')
  if (!isValidName(name)) {
    throw requestError(400, ERROR_CODES.INVALID_NAME, 'A valid baseline name is required')
  }
  return name
}

function readRunId (url) {
  const runId = singleParam(url, 'run', ERROR_CODES.INVALID_RUN_ID, 'A valid run id is required')
  if (!isValidRunId(runId)) {
    throw requestError(400, ERROR_CODES.INVALID_RUN_ID, 'A valid run id is required')
  }
  return runId
}

function readArtifactFilename (url) {
  const filename = singleParam(url, 'filename', 'INVALID_ARTIFACT', 'A known artifact filename is required')
  if (!ARTIFACT_TYPES.has(filename)) {
    throw requestError(400, 'INVALID_ARTIFACT', 'A known artifact filename is required')
  }
  return filename
}

function singleParam (url, key, code, message) {
  const values = url.searchParams.getAll(key)
  if (values.length !== 1) throw requestError(400, code, message)
  return values[0]
}

function requireMethod (req, allowed) {
  if (allowed.includes(req.method)) return
  discardBody(req)
  const error = requestError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
  error.headers = { allow: allowed.join(', ') }
  throw error
}

function requireContentType (req, expected) {
  const received = mediaType(req.headers['content-type'])
  if (received === expected) return
  discardBody(req)
  throw requestError(415, 'UNSUPPORTED_MEDIA_TYPE', `Expected ${expected}`)
}

function mediaType (header) {
  if (typeof header !== 'string') return ''
  return header.split(';', 1)[0].trim().toLowerCase()
}

function hasToken (req, expected) {
  const header = req.headers['x-snapeye-token']
  if (typeof header !== 'string') return false
  const actualBytes = Buffer.from(header)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

async function readBody (req, limit) {
  // A request can disconnect while an earlier write holds this run's queue.
  // Its abort/end event has already fired by the time we get here; waiting for
  // another event would leave the queue locked forever.
  if (req.aborted || req.destroyed) {
    throw requestError(400, 'INVALID_REQUEST', 'Request body was aborted')
  }
  if (req.readableEnded) {
    throw requestError(400, 'INVALID_REQUEST', 'Request body has already been consumed')
  }
  const declared = req.headers['content-length']
  if (declared != null) {
    if (typeof declared !== 'string' || !/^\d+$/.test(declared)) {
      discardBody(req)
      throw requestError(400, 'INVALID_REQUEST', 'Invalid Content-Length header')
    }
    if (Number(declared) > limit) {
      discardBody(req)
      throw requestError(413, 'PAYLOAD_TOO_LARGE', 'SnapEye request body is too large')
    }
  }

  return await new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false

    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
    }
    const fail = (error, drain = false) => {
      if (settled) return
      settled = true
      cleanup()
      if (drain) req.resume()
      reject(error)
    }
    const onData = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += bytes.length
      if (total > limit) {
        fail(requestError(413, 'PAYLOAD_TOO_LARGE', 'SnapEye request body is too large'), true)
        return
      }
      chunks.push(bytes)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks, total))
    }
    const onError = () => fail(requestError(400, 'INVALID_REQUEST', 'Could not read request body'))
    const onAborted = () => fail(requestError(400, 'INVALID_REQUEST', 'Request body was aborted'))

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
  })
}

async function assertSafeBaselineFiles (store, name) {
  const directory = store?.paths?.baselines
  if (typeof directory !== 'string') return
  for (const extension of ['.png', '.json']) {
    try {
      const stats = await lstat(join(directory, `${name}${extension}`))
      if (stats.isSymbolicLink()) {
        throw requestError(409, 'UNSAFE_ARTIFACT_PATH', 'SnapEye refused an unsafe baseline path')
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

async function isCommitted (store, committedRuns, runId) {
  if (committedRuns.has(runId)) return true
  if (typeof store.readResult !== 'function') return false
  const existing = await store.readResult(runId)
  if (existing == null) return false
  committedRuns.add(runId)
  return true
}

async function serializeRun (queues, runId, operation) {
  const previous = queues.get(runId) ?? Promise.resolve()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const tail = previous.then(() => gate)
  queues.set(runId, tail)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (queues.get(runId) === tail) queues.delete(runId)
  }
}

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function discardBody (req) {
  if (!req.readableEnded && !req.destroyed) req.resume()
}

function pass (next) {
  if (typeof next === 'function') next()
  return false
}

function sendJson (res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': `${JSON_TYPE}; charset=utf-8`,
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers
  })
  res.end(body)
  return true
}

function sendBytes (res, status, contentType, value) {
  const body = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end(body)
  return true
}

function sendEmpty (res, status) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  })
  res.end()
  return true
}

function sendError (res, error) {
  return sendJson(res, error.status, {
    error: {
      code: error.code,
      message: error.message
    }
  }, error.headers)
}

function normalizeRequestError (error) {
  if (error instanceof RequestError) return error
  if (error?.code === 'RESULT_ALREADY_COMMITTED' || error?.code === 'RUN_ALREADY_TERMINAL') {
    return requestError(409, 'RUN_ALREADY_COMMITTED', 'The SnapEye run already has a terminal result')
  }
  if (error?.code === 'INVALID_PATH' || error?.code === 'INVALID_RESULT') {
    return requestError(400, 'INVALID_REQUEST', 'SnapEye refused an invalid request')
  }
  return requestError(500, 'INTERNAL_ERROR', 'SnapEye could not persist the request')
}

function requestError (status, code, message) {
  return new RequestError(status, code, message)
}

class RequestError extends Error {
  constructor (status, code, message) {
    super(message)
    this.name = 'RequestError'
    this.status = status
    this.code = code
    this.headers = undefined
  }
}

export { ARTIFACT_TYPES, BASELINE_TYPE }
