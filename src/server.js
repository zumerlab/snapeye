/**
 * SnapEye server handler — receives POSTs from the client and writes the
 * artifacts to disk so a coding agent can `Read` them.
 *
 * Framework-agnostic: returns a single async handler that takes
 * Node's (req, res) and returns `true` if it handled the request.
 *
 *   import { createSnapEyeHandler } from '@zumer/snapeye/server'
 *   const snapEye = createSnapEyeHandler({ dir: '.snapeye' })
 *
 *   // Node http
 *   createServer(async (req, res) => {
 *     if (await snapEye(req, res)) return
 *     // … your own routing …
 *   })
 *
 *   // Express / Connect
 *   app.use(async (req, res, next) => {
 *     if (!(await snapEye(req, res))) next()
 *   })
 *
 * Endpoints (mounted under `prefix`):
 *   POST /snap?name=X     image/png  →  <dir>/<X>.png
 *   POST /log             text/plain →  stdout as `[browser] …`
 *
 * Filenames are sanitized to `[a-z0-9._-]`. Missing names fall back to
 * `snap-<timestamp>`. Anything else is a 404.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'

const DEFAULTS = {
  /** Directory (relative to cwd) where PNGs are written. */
  dir: '.snapeye',
  /** Path prefix the client uses. Must match `endpoint` on the client. */
  prefix: '/__snapeye__',
  /** Log callback. Defaults to console.log; pass null to silence. */
  log: (line) => console.log(line),
  /** Hook invoked after every successful snap. */
  onSnap: null,
  /** Hook invoked after every successful log. */
  onLog: null
}

function safe (s) { return String(s || `snap-${Date.now()}`).replace(/[^a-z0-9._-]/gi, '_') }

async function readBody (req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

export function createSnapEyeHandler (userOpts = {}) {
  const opts = { ...DEFAULTS, ...userOpts }
  const outDir = resolve(process.cwd(), opts.dir)

  return async function snapEye (req, res) {
    if (req.method !== 'POST') return false
    const url = new URL(req.url, 'http://x')
    if (!url.pathname.startsWith(opts.prefix + '/')) return false

    const route = url.pathname.slice(opts.prefix.length + 1)
    const name  = safe(url.searchParams.get('name'))

    try {
      if (route === 'snap') {
        const body = await readBody(req)
        const path = join(outDir, `${name}.png`)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, body)
        if (opts.log) opts.log(`📸 snapeye → ${path} (${body.length} B)`)
        if (opts.onSnap) opts.onSnap({ name, path, bytes: body.length })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, name, path: `${opts.dir}/${name}.png` }))
        return true
      }

      if (route === 'log') {
        const body = (await readBody(req)).toString('utf8')
        if (opts.log) opts.log(`[browser] ${body}`)
        if (opts.onLog) opts.onLog({ line: body })
        res.writeHead(204); res.end()
        return true
      }

      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end(`unknown snapeye route: ${route}`)
      return true
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end(String(err))
      if (opts.log) opts.log(`snapeye error: ${err.message || err}`)
      return true
    }
  }
}

export default createSnapEyeHandler
