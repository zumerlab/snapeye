import { encodeBaselineEnvelope, decodeBaselineEnvelope } from '../core/envelope.js'
import { ERROR_CODES } from '../core/protocol.js'
import { SnapEyeError } from '../core/errors.js'

const BASELINE_TYPE = 'application/vnd.snapeye.baseline'

/** Same-origin HTTP implementation of the ArtifactStore contract. */
export function createHttpArtifactStore ({
  endpoint = '/__snapeye',
  token,
  fetch: fetchImpl = globalThis.fetch
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('SnapEye HTTP transport requires fetch')
  const base = String(endpoint).replace(/\/+$/, '')

  async function request (path, init = {}, expected = null) {
    const headers = new Headers(init.headers)
    if (token) headers.set('x-snapeye-token', token)
    let response
    try {
      response = await fetchImpl(`${base}${path}`, { ...init, headers })
    } catch (error) {
      throw persistFailure(error)
    }
    if (!response.ok) {
      let message = `SnapEye artifact request failed (${response.status})`
      try {
        const body = await response.json()
        if (typeof body?.error?.message === 'string') message = body.error.message
      } catch {}
      throw new SnapEyeError(ERROR_CODES.PERSIST_FAILED, message)
    }
    if (expected) {
      const received = response.headers.get('content-type')?.split(';')[0].trim()
      if (received !== expected) {
        throw new SnapEyeError(ERROR_CODES.PERSIST_FAILED, 'SnapEye artifact server returned an unexpected content type')
      }
    }
    return response
  }

  async function readBaseline (name) {
    const response = await request(`/baseline?name=${encodeURIComponent(name)}`, { method: 'GET' })
    if (response.status === 204) return null
    const received = response.headers.get('content-type')?.split(';')[0].trim()
    if (received !== BASELINE_TYPE) {
      throw new SnapEyeError(ERROR_CODES.PERSIST_FAILED, 'SnapEye artifact server returned an invalid baseline')
    }
    const decoded = decodeBaselineEnvelope(await response.arrayBuffer())
    return {
      name,
      meta: decoded.meta,
      image: new Blob([decoded.image], { type: 'image/png' })
    }
  }

  async function writeBaseline (name, baseline) {
    const body = await encodeBaselineEnvelope(baseline)
    await request(`/baseline?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': BASELINE_TYPE },
      body
    })
  }

  async function writeRunArtifact (runId, filename, data) {
    await request(
      `/artifact?run=${encodeURIComponent(runId)}&filename=${encodeURIComponent(filename)}`,
      {
        method: 'POST',
        headers: { 'content-type': artifactType(filename) },
        body: data
      }
    )
  }

  async function commitResult (runId, result) {
    await request(`/result?run=${encodeURIComponent(runId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result)
    })
  }

  async function log (level, ...args) {
    const body = args.map(formatLogValue).join(' ')
    try {
      await request('/log', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: `[${level}] ${body}`
      })
      return true
    } catch {
      return false
    }
  }

  return { readBaseline, writeBaseline, writeRunArtifact, commitResult, log }
}

function artifactType (filename) {
  if (filename.endsWith('.png')) return 'image/png'
  if (filename.endsWith('.gif')) return 'image/gif'
  if (filename.endsWith('.webm')) return 'video/webm'
  if (filename.endsWith('.mp4')) return 'video/mp4'
  return 'application/octet-stream'
}

function persistFailure () {
  return new SnapEyeError(ERROR_CODES.PERSIST_FAILED, 'SnapEye artifact server is not reachable')
}

function formatLogValue (value) {
  if (value instanceof Error) return value.stack || value.message
  if (typeof value === 'object' && value !== null) {
    try { return JSON.stringify(value) } catch {}
  }
  return String(value)
}

export { BASELINE_TYPE }

