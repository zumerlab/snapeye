import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { decodeBaselineEnvelope, encodeBaselineEnvelope } from '../../src/core/envelope.js'
import { buildResult } from '../../src/core/result.js'
import { createFsArtifactStore } from '../../src/node/fs-store.js'
import {
  ARTIFACT_TYPES,
  BASELINE_TYPE,
  createSnapEyeHttpHandler
} from '../../src/node/http-handler.js'

// Read the real version: hardcoding it here means every release bump fails
// the suite for a reason that has nothing to do with the contract.
const { version: VERSION } = createRequire(import.meta.url)('../../package.json')

const TOKEN = 'snapeye-test-token-1234567890'
const MAX_REQUEST_BYTES = 512
const ENDPOINT = '/__snapeye'

describe('SnapEye HTTP handler', () => {
  let sandbox
  let store
  let server
  let baseUrl

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'snapeye-http-'))
    store = createFsArtifactStore({ root: join(sandbox, '.snapeye') })
    await store.ensureLayout()

    const handler = createSnapEyeHttpHandler({
      store,
      token: TOKEN,
      endpoint: ENDPOINT,
      maxRequestBytes: MAX_REQUEST_BYTES
    })
    server = createServer(async (request, response) => {
      const handled = await handler(request, response)
      if (!handled && !response.writableEnded) {
        response.writeHead(404, { 'content-type': 'text/plain' })
        response.end('host application route')
      }
    })
    await listen(server)
    const address = server.address()
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    if (server?.listening) {
      server.closeIdleConnections?.()
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    }
    if (sandbox) await rm(sandbox, { recursive: true, force: true })
  })

  it('serves the exact public health contract without a token', async () => {
    const response = await request('/health')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.json()).toEqual({
      status: 'ok',
      name: '@zumer/snapeye',
      version: VERSION,
      protocolVersion: 1,
      artifactRoot: '.snapeye',
      // The configured root is relative to the dev server's project root; a CLI
      // invoked elsewhere needs the absolute one to find `runs/<id>/result.json`.
      artifactRootResolved: store.paths.root
    })
    // The token is a write credential and never appears in the public payload.
    expect(JSON.stringify(await (await request('/health')).json())).not.toContain(TOKEN)
  })

  it('requires the injected token for every non-health endpoint', async () => {
    const missing = await request('/baseline?name=dashboard')
    const invalid = await request('/baseline?name=dashboard', {
      headers: { 'x-snapeye-token': 'not-the-token' }
    })
    const authorized = await authorizedRequest('/baseline?name=dashboard')

    await expectError(missing, 401, 'UNAUTHORIZED', 'Invalid or missing SnapEye token')
    await expectError(invalid, 401, 'UNAUTHORIZED', 'Invalid or missing SnapEye token')
    expect(authorized.status).toBe(204)
  })

  it('validates methods, content types, and request body limits', async () => {
    const healthMethod = await request('/health', { method: 'POST' })
    await expectError(healthMethod, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
    expect(healthMethod.headers.get('allow')).toBe('GET')

    const artifactMethod = await authorizedRequest(
      '/artifact?run=methodRun&filename=current.png',
      { method: 'GET' }
    )
    await expectError(artifactMethod, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
    expect(artifactMethod.headers.get('allow')).toBe('POST')

    const wrongType = await authorizedRequest('/result?run=typeRun', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}'
    })
    await expectError(
      wrongType,
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Expected application/json'
    )

    const oversized = await authorizedRequest(
      '/artifact?run=largeRun&filename=current.png',
      {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: new Uint8Array(MAX_REQUEST_BYTES + 1)
      }
    )
    await expectError(
      oversized,
      413,
      'PAYLOAD_TOO_LARGE',
      'SnapEye request body is too large'
    )
    await expect(access(join(store.paths.runs, 'largeRun', 'current.png')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('round-trips a baseline envelope through the real filesystem store', async () => {
    const metadata = {
      schemaVersion: 1,
      name: 'dashboard',
      capturedAt: '2026-08-26T12:00:00.000Z',
      target: { selector: '#dashboard' },
      image: {
        coordinateSpace: 'target-css-px',
        cssWidth: 320,
        cssHeight: 180,
        pixelWidth: 640,
        pixelHeight: 360,
        scale: 2
      }
    }
    const image = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const envelope = await encodeBaselineEnvelope({ meta: metadata, image })

    const write = await authorizedRequest('/baseline?name=dashboard', {
      method: 'POST',
      headers: { 'content-type': BASELINE_TYPE },
      body: envelope
    })
    expect(write.status).toBe(204)

    const read = await authorizedRequest('/baseline?name=dashboard')
    expect(read.status).toBe(200)
    expect(read.headers.get('content-type')).toBe(BASELINE_TYPE)
    const decoded = decodeBaselineEnvelope(new Uint8Array(await read.arrayBuffer()))
    expect(decoded.meta).toEqual(metadata)
    expect([...decoded.image]).toEqual([...image])
    expect(await readFile(join(store.paths.baselines, 'dashboard.png'))).toEqual(Buffer.from(image))
    expect(JSON.parse(await readFile(join(store.paths.baselines, 'dashboard.json'), 'utf8')))
      .toMatchObject({
        ...metadata,
        __snapeyeBaselineCommit: {
          format: 'snapeye-baseline-v1',
          state: 'committed',
          image: { algorithm: 'sha256', byteLength: image.byteLength }
        }
      })
  })

  it.each([
    ['/baseline?name=..%2Foutside', 'INVALID_NAME'],
    ['/baseline?name=dashboard%00escape', 'INVALID_NAME'],
    ['/artifact?run=..%2Foutside&filename=current.png', 'INVALID_RUN_ID'],
    ['/artifact?run=one&run=two&filename=current.png', 'INVALID_RUN_ID'],
    ['/artifact?run=safeRun&filename=..%2Fcurrent.png', 'INVALID_ARTIFACT']
  ])('rejects invalid names, run ids, and traversal in %s', async (path, code) => {
    const response = await authorizedRequest(path, {
      method: path.startsWith('/baseline') ? 'GET' : 'POST',
      headers: path.startsWith('/artifact') ? { 'content-type': 'image/png' } : undefined,
      body: path.startsWith('/artifact') ? new Uint8Array([1]) : undefined
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code } })
    expect(await readdir(store.paths.baselines)).toEqual([])
    expect(await readdir(store.paths.runs)).toEqual([])
  })

  it('accepts only the fixed artifact filename and content-type allowlist', async () => {
    let index = 0
    for (const [filename, contentType] of ARTIFACT_TYPES) {
      const runId = `allowed_${index}`
      const data = new Uint8Array([index, 42])
      const response = await authorizedRequest(
        `/artifact?run=${runId}&filename=${encodeURIComponent(filename)}`,
        {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: data
        }
      )

      expect(response.status, filename).toBe(204)
      expect(await readFile(join(store.paths.runs, runId, filename))).toEqual(Buffer.from(data))
      index++
    }

    for (const filename of ['result.json', 'notes.txt', 'CURRENT.PNG']) {
      const response = await authorizedRequest(
        `/artifact?run=rejectedRun&filename=${encodeURIComponent(filename)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: new Uint8Array([1])
        }
      )
      await expectError(
        response,
        400,
        'INVALID_ARTIFACT',
        'A known artifact filename is required'
      )
    }
    await expect(access(join(store.paths.runs, 'rejectedRun')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('publishes one terminal result and rejects duplicate or late writes with 409', async () => {
    const runId = 'terminalRun'
    const initialArtifact = new Uint8Array([1, 2, 3])
    const artifact = await authorizedRequest(`/artifact?run=${runId}&filename=current.png`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: initialArtifact
    })
    expect(artifact.status).toBe(204)

    const result = buildResult({
      runId,
      status: 'ok',
      operation: 'capture',
      name: 'dashboard'
    })
    const committed = await postResult(runId, result)
    expect(committed.status).toBe(204)
    expect(await store.readResult(runId)).toEqual(result)

    const duplicate = await postResult(runId, { ...result, name: 'replacement' })
    await expectError(
      duplicate,
      409,
      'RUN_ALREADY_COMMITTED',
      'The SnapEye run already has a terminal result'
    )

    const lateArtifact = await authorizedRequest(`/artifact?run=${runId}&filename=current.png`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array([9, 9, 9])
    })
    await expectError(
      lateArtifact,
      409,
      'RUN_ALREADY_COMMITTED',
      'The SnapEye run already has a terminal result'
    )
    expect(await store.readResult(runId)).toEqual(result)
    expect(await readFile(join(store.paths.runs, runId, 'current.png')))
      .toEqual(Buffer.from(initialArtifact))
  })

  it('returns sanitized errors without stacks, secrets, or filesystem paths', async () => {
    const secret = `private failure at ${sandbox}`
    store.writeRunArtifact = async () => {
      const error = new Error(secret)
      error.stack = `Error: ${secret}\n    at privateImplementation (/secret/source.js:1:1)`
      throw error
    }

    const response = await authorizedRequest('/artifact?run=failedRun&filename=current.png', {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array([1, 2, 3])
    })
    const body = await response.text()

    expect(response.status).toBe(500)
    expect(JSON.parse(body)).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'SnapEye could not persist the request'
      }
    })
    expect(body).not.toContain('stack')
    expect(body).not.toContain(secret)
    expect(body).not.toContain(sandbox)
    expect(body).not.toContain('/secret/source.js')
  })

  async function request (path, init) {
    return fetch(`${baseUrl}${ENDPOINT}${path}`, init)
  }

  async function authorizedRequest (path, init = {}) {
    return request(path, {
      ...init,
      headers: {
        'x-snapeye-token': TOKEN,
        ...init.headers
      }
    })
  }

  async function postResult (runId, result) {
    return authorizedRequest(`/result?run=${encodeURIComponent(runId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(result)
    })
  }
})

async function expectError (response, status, code, message) {
  expect(response.status).toBe(status)
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
  expect(await response.json()).toEqual({ error: { code, message } })
}

function listen (server) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })
}
