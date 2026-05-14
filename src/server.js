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
 *   GET  /prev?name=X                       →  bytes of <dir>/<X>.png (404 if none)
 *   POST /snap?name=X     image/png         →  <dir>/<X>.png
 *   POST /dom?name=X      text/html         →  <dir>/<X>.html
 *   POST /map?name=X      application/json  →  <dir>/<X>.png + <dir>/<X>.map.json
 *   POST /diff?name=X     application/json  →  <dir>/<X>.png + <X>.prev.png + <X>.diff.png + <X>.diff.json
 *   POST /log             text/plain        →  stdout as `[browser] …`
 *
 * Every endpoint accepts an optional `?namespace=X` query param. When set
 * (or when the handler is created with `namespace: 'X'`), output is
 * nested under `<dir>/<X>/` so multiple agents can capture in parallel
 * without clobbering each other's files.
 *
 * Filenames are sanitized to `[a-z0-9._-]`. Namespaces are sanitized to
 * `[a-z0-9_-]` (no dots — prevents path traversal).
 */
import { writeFile, mkdir, readFile, rename } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'

const DEFAULTS = {
  /** Directory (relative to cwd) where PNG/HTML are written. */
  dir: '.snapeye',
  /** Path prefix the client uses. Must match `endpoint` on the client. */
  prefix: '/__snapeye__',
  /** Default namespace. `?namespace=X` on a request overrides this. */
  namespace: '',
  /** Log callback. Defaults to console.log; pass null to silence. */
  log: (line) => console.log(line),
  /** Hook invoked after every successful snap. */
  onSnap: null,
  /** Hook invoked after every successful agent-map capture. */
  onMap: null,
  /** Hook invoked after every successful diff capture. */
  onDiff: null,
  /** Hook invoked after every successful log. */
  onLog: null
}

function safe (s) { return String(s || `snap-${Date.now()}`).replace(/[^a-z0-9._-]/gi, '_') }
function safeNs (s) { return s ? String(s).replace(/[^a-z0-9_-]/gi, '_') : '' }

async function readBody (req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

export function createSnapEyeHandler (userOpts = {}) {
  const opts = { ...DEFAULTS, ...userOpts }
  const outDir = resolve(process.cwd(), opts.dir)

  return async function snapEye (req, res) {
    const url = new URL(req.url, 'http://x')
    if (!url.pathname.startsWith(opts.prefix + '/')) return false

    const route = url.pathname.slice(opts.prefix.length + 1)
    const name  = safe(url.searchParams.get('name'))
    const ns    = safeNs(url.searchParams.get('namespace') || opts.namespace)
    const dir   = ns ? join(outDir, ns) : outDir
    const rel   = (file) => ns ? `${opts.dir}/${ns}/${file}` : `${opts.dir}/${file}`

    // GET /prev — read the current <name>.png so the client can diff against it.
    if (req.method === 'GET' && route === 'prev') {
      try {
        const buf = await readFile(join(dir, `${name}.png`))
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length })
        res.end(buf)
      } catch {
        res.writeHead(404); res.end()
      }
      return true
    }

    if (req.method !== 'POST') return false

    try {
      if (route === 'snap') {
        const body = await readBody(req)
        const path = join(dir, `${name}.png`)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, body)
        if (opts.log) opts.log(`📸 snapeye → ${path} (${body.length} B)`)
        if (opts.onSnap) opts.onSnap({ name, namespace: ns, path, bytes: body.length })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, name, namespace: ns, path: rel(`${name}.png`) }))
        return true
      }

      if (route === 'dom') {
        const body = await readBody(req)
        const path = join(dir, `${name}.html`)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, body)
        if (opts.log) opts.log(`📄 snapeye → ${path}`)
        res.writeHead(204); res.end()
        return true
      }

      if (route === 'map') {
        const raw = (await readBody(req)).toString('utf8')
        let payload
        try { payload = JSON.parse(raw) } catch {
          res.writeHead(400, { 'content-type': 'text/plain' })
          res.end('map: body must be JSON { image?, map, dimensions }')
          return true
        }
        const { image, map = [], dimensions = {} } = payload
        const jsonPath = join(dir, `${name}.map.json`)
        await mkdir(dirname(jsonPath), { recursive: true })
        await writeFile(jsonPath, JSON.stringify({ map, dimensions }, null, 2))

        let pngPath = null
        if (typeof image === 'string' && image.startsWith('data:image/')) {
          const comma = image.indexOf(',')
          if (comma > -1) {
            const buf = Buffer.from(image.slice(comma + 1), 'base64')
            pngPath = join(dir, `${name}.png`)
            await writeFile(pngPath, buf)
          }
        }

        if (opts.log) opts.log(`🗺  snapeye → ${jsonPath} (${map.length} marks${pngPath ? ', annotated png' : ''})`)
        if (opts.onMap) opts.onMap({ name, namespace: ns, jsonPath, pngPath, marks: map.length })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          ok: true, name, namespace: ns, marks: map.length,
          jsonPath: rel(`${name}.map.json`),
          pngPath: pngPath ? rel(`${name}.png`) : null
        }))
        return true
      }

      if (route === 'diff') {
        const raw = (await readBody(req)).toString('utf8')
        let payload
        try { payload = JSON.parse(raw) } catch {
          res.writeHead(400, { 'content-type': 'text/plain' })
          res.end('diff: body must be JSON { image, diff, stats }')
          return true
        }
        const { image, diff, stats = {} } = payload
        const curPath  = join(dir, `${name}.png`)
        const prevPath = join(dir, `${name}.prev.png`)
        await mkdir(dir, { recursive: true })

        // Rotate: today's current → previous. First-ever call has no current,
        // so rename fails harmlessly.
        let rotated = false
        try { await rename(curPath, prevPath); rotated = true } catch {}

        const dataUrlToFile = async (dataUrl, path) => {
          if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null
          const comma = dataUrl.indexOf(',')
          if (comma < 0) return null
          await writeFile(path, Buffer.from(dataUrl.slice(comma + 1), 'base64'))
          return path
        }

        const wroteCur  = await dataUrlToFile(image, curPath)
        const diffPath  = join(dir, `${name}.diff.png`)
        const wroteDiff = await dataUrlToFile(diff, diffPath)
        const jsonPath  = join(dir, `${name}.diff.json`)
        await writeFile(jsonPath, JSON.stringify(stats, null, 2))

        const pct = typeof stats.ratio === 'number' ? `${(stats.ratio * 100).toFixed(2)}%` : 'n/a'
        if (opts.log) opts.log(`🔄 snapeye → ${jsonPath} (${pct} ${rotated ? 'vs prev' : 'baseline'})`)
        if (opts.onDiff) opts.onDiff({
          name, namespace: ns, stats,
          curPath:  wroteCur,
          prevPath: rotated ? prevPath : null,
          diffPath: wroteDiff,
          jsonPath
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          ok: true, name, namespace: ns, stats,
          curPath:  wroteCur  ? rel(`${name}.png`) : null,
          prevPath: rotated   ? rel(`${name}.prev.png`) : null,
          diffPath: wroteDiff ? rel(`${name}.diff.png`) : null,
          jsonPath: rel(`${name}.diff.json`)
        }))
        return true
      }

      if (route === 'log') {
        const body = (await readBody(req)).toString('utf8')
        const tag  = ns ? `[browser:${ns}]` : '[browser]'
        if (opts.log) opts.log(`${tag} ${body}`)
        if (opts.onLog) opts.onLog({ line: body, namespace: ns })
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
