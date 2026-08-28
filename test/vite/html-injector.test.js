import { describe, expect, it } from 'vitest'
import { createHtmlInjector } from '../../src/vite.js'

const TAG = '<script type="module" src="/@id/virtual:@zumer/snapeye/client" data-snapeye-client></script>'

describe('HTML client injection', () => {
  it('injects into a page streamed as Uint8Array chunks', async () => {
    // A framework rendering through a web ReadableStream writes Uint8Array, not
    // Buffer. Accepting only Buffer let every Astro page through untouched
    // while health still answered "ok" — the exact silent failure this exists
    // to prevent.
    const res = fakeResponse()
    inject(res)
    res.writeHead(200, { 'content-type': 'text/html' })
    for (const part of ['<!DOCTYPE html><html lang="en">', '<head>', '<title>x</title></head>', '<body>hi</body></html>']) {
      res.write(new TextEncoder().encode(part))
    }
    res.end()

    expect(res.body()).toBe(
      `<!DOCTYPE html><html lang="en"><head>${TAG}<title>x</title></head><body>hi</body></html>`
    )
  })

  it('reads the content type from writeHead, which getHeader never sees', () => {
    const res = fakeResponse()
    inject(res)
    // Headers given to writeHead go straight to the socket.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': '42' })
    res.end('<html><head></head><body></body></html>')

    expect(res.body()).toContain(TAG)
    // Injecting adds bytes, so a declared length would contradict the body.
    expect(res.headers['Content-Length']).toBeUndefined()
  })

  it('injects when <head> straddles two chunks', () => {
    const res = fakeResponse()
    inject(res)
    res.setHeader('content-type', 'text/html')
    res.write('<html><he')
    res.write('ad><title>x</title></head><body></body></html>')
    res.end()

    expect(res.body()).toBe(`<html><head>${TAG}<title>x</title></head><body></body></html>`)
  })

  it('never injects twice', () => {
    const res = fakeResponse()
    inject(res)
    res.setHeader('content-type', 'text/html')
    res.end(`<html><head>${TAG}</head><body></body></html>`)

    expect(res.body().match(/data-snapeye-client/g)).toHaveLength(1)
  })

  it('leaves everything that is not an HTML page alone', () => {
    const json = fakeResponse()
    inject(json)
    json.setHeader('content-type', 'application/json')
    json.end('{"head":"<head>"}')
    expect(json.body()).toBe('{"head":"<head>"}')

    const binary = fakeResponse()
    inject(binary)
    binary.setHeader('content-type', 'image/png')
    binary.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(binary.chunks).toHaveLength(1)
  })

  it('does not touch requests that are not navigations', () => {
    for (const req of [{ method: 'POST', headers: { accept: 'text/html' } }, { method: 'GET', headers: { accept: 'application/json' } }, { method: 'GET', headers: {} }]) {
      const res = fakeResponse()
      let called = false
      createHtmlInjector(() => TAG)(req, res, () => { called = true })
      expect(called).toBe(true)
      // The response object is untouched, so nothing downstream is wrapped.
      expect(res.write).toBe(res.originalWrite)
    }
  })

  it('emits a page with no head unchanged', () => {
    const res = fakeResponse()
    inject(res)
    res.setHeader('content-type', 'text/html')
    res.write('<html><body>')
    res.write('no head here at all</body></html>')
    res.end()

    expect(res.body()).toBe('<html><body>no head here at all</body></html>')
  })
})

function inject (res, req = { method: 'GET', headers: { accept: 'text/html' } }) {
  createHtmlInjector(() => TAG)(req, res, () => {})
}

function fakeResponse () {
  const res = {
    headers: {},
    chunks: [],
    headersSent: false,
    setHeader (name, value) { this.headers[name] = value },
    getHeader (name) {
      const key = Object.keys(this.headers).find(k => k.toLowerCase() === name.toLowerCase())
      return key ? this.headers[key] : undefined
    },
    removeHeader (name) {
      const key = Object.keys(this.headers).find(k => k.toLowerCase() === name.toLowerCase())
      if (key) delete this.headers[key]
    },
    writeHead (status, statusMessage, headers) {
      const map = (statusMessage && typeof statusMessage === 'object' ? statusMessage : headers) || {}
      Object.assign(this.headers, map)
      this.headersSent = true
      return this
    },
    write (chunk) { if (chunk != null && chunk !== '') this.chunks.push(chunk); return true },
    end (chunk) { if (chunk != null && chunk !== '') this.chunks.push(chunk); return this },
    body () {
      return this.chunks.map(c => typeof c === 'string' ? c : Buffer.from(c.buffer ?? c, c.byteOffset ?? 0, c.byteLength ?? c.length).toString('utf8')).join('')
    }
  }
  res.originalWrite = res.write
  return res
}
