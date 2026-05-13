/**
 * Standalone example — Node http server that:
 *   - serves index.html
 *   - mounts the SnapEye handler under /__snapeye__
 *
 * Run:  node server.mjs   →  http://localhost:8090
 * Then: open http://localhost:8090/?snap=demo
 * And:  ls .snapeye/      →  demo.png  demo.html
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { createSnapEyeHandler } from '../../src/server.js'

const PORT = Number(process.env.PORT) || 8090
// Serve from the repo root so `/src/client.js` resolves alongside
// `/examples/standalone/index.html`.
const HERE = resolve(new URL('.', import.meta.url).pathname)
const ROOT = resolve(HERE, '../..')
const ENTRY = '/examples/standalone/index.html'
// Absolute output dir so cwd doesn't matter.
const snapEye = createSnapEyeHandler({ dir: resolve(HERE, '.snapeye') })

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png'
}

createServer(async (req, res) => {
  if (await snapEye(req, res)) return

  let path = req.url.split('?')[0]
  if (path === '/') path = ENTRY
  const file = join(ROOT, path)
  try {
    const s = await stat(file)
    if (!s.isFile()) throw new Error('not file')
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(await readFile(file))
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end(`404 ${path}`)
  }
}).listen(PORT, () => {
  console.log(`snapeye example → http://localhost:${PORT}`)
  console.log(`try:               http://localhost:${PORT}/?snap=hello`)
})
