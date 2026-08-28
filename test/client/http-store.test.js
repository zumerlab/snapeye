import { describe, expect, it, vi } from 'vitest'
import { createHttpArtifactStore, BASELINE_TYPE } from '../../src/client/http-store.js'
import { decodeBaselineEnvelope } from '../../src/core/envelope.js'

describe('HTTP artifact store', () => {
  it('round-trips a baseline envelope with the token and exact media type', async () => {
    let persistedEnvelope
    const fetch = vi.fn(async (url, init) => {
      if (init.method === 'POST') {
        persistedEnvelope = init.body
        return new Response(null, { status: 204 })
      }
      return new Response(persistedEnvelope, {
        status: 200,
        headers: { 'content-type': `${BASELINE_TYPE}; charset=binary` }
      })
    })
    const store = createHttpArtifactStore({
      endpoint: '/__snapeye/',
      token: 'ephemeral-token',
      fetch
    })
    const imageBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
    const meta = { width: 20, height: 10, coordinateSpace: 'css-px' }

    await store.writeBaseline('hero.card', {
      image: new Blob([imageBytes], { type: 'image/png' }),
      meta
    })
    const baseline = await store.readBaseline('hero.card')

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/__snapeye/baseline?name=hero.card',
      '/__snapeye/baseline?name=hero.card'
    ])
    const [, post] = fetch.mock.calls[0]
    const [, get] = fetch.mock.calls[1]
    expect(post.method).toBe('POST')
    expect(post.headers.get('x-snapeye-token')).toBe('ephemeral-token')
    expect(post.headers.get('content-type')).toBe(BASELINE_TYPE)
    expect(get.method).toBe('GET')
    expect(get.headers.get('x-snapeye-token')).toBe('ephemeral-token')

    const decodedRequest = decodeBaselineEnvelope(persistedEnvelope)
    expect(decodedRequest.meta).toEqual(meta)
    expect([...decodedRequest.image]).toEqual([...imageBytes])
    expect(baseline).toMatchObject({ name: 'hero.card', meta })
    expect(baseline.image.type).toBe('image/png')
    expect([...new Uint8Array(await baseline.image.arrayBuffer())]).toEqual([...imageBytes])
  })

  it('sends the token and operation-specific content types on every write', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }))
    const store = createHttpArtifactStore({
      endpoint: '/transport',
      token: 'secret',
      fetch
    })
    const result = { runId: 'run_1', status: 'ok' }

    await store.writeRunArtifact('run_1', 'diff.png', new Blob(['png']))
    await store.writeRunArtifact('run_1', 'recording.webm', new Blob(['webm']))
    await store.commitResult('run_1', result)
    await expect(store.log('warn', 'bad', { count: 2 })).resolves.toBe(true)

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/transport/artifact?run=run_1&filename=diff.png',
      '/transport/artifact?run=run_1&filename=recording.webm',
      '/transport/result?run=run_1',
      '/transport/log'
    ])
    const contentTypes = fetch.mock.calls.map(([, init]) => init.headers.get('content-type'))
    expect(contentTypes).toEqual([
      'image/png',
      'video/webm',
      'application/json',
      'text/plain'
    ])
    for (const [, init] of fetch.mock.calls) {
      expect(init.method).toBe('POST')
      expect(init.headers.get('x-snapeye-token')).toBe('secret')
    }
    expect(fetch.mock.calls[2][1].body).toBe(JSON.stringify(result))
    expect(fetch.mock.calls[3][1].body).toBe('[warn] bad {"count":2}')
  })

  it('turns server and transport failures into stable persistence errors', async () => {
    const denied = createHttpArtifactStore({
      fetch: vi.fn(async () => new Response(
        JSON.stringify({ error: { message: 'token rejected' } }),
        { status: 403, headers: { 'content-type': 'application/json' } }
      ))
    })
    const offline = createHttpArtifactStore({
      fetch: vi.fn(async () => { throw new Error('socket details must not leak') })
    })

    await expect(denied.commitResult('run_1', {})).rejects.toMatchObject({
      name: 'SnapEyeError',
      code: 'PERSIST_FAILED',
      message: 'token rejected'
    })
    await expect(offline.readBaseline('hero')).rejects.toMatchObject({
      name: 'SnapEyeError',
      code: 'PERSIST_FAILED',
      message: 'SnapEye artifact server is not reachable'
    })
  })

  it('rejects a baseline response with an unexpected content type', async () => {
    const store = createHttpArtifactStore({
      fetch: vi.fn(async () => new Response('not an envelope', {
        status: 200,
        headers: { 'content-type': 'text/plain' }
      }))
    })

    await expect(store.readBaseline('hero')).rejects.toMatchObject({
      code: 'PERSIST_FAILED',
      message: 'SnapEye artifact server returned an invalid baseline'
    })
  })
})
