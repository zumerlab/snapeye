/**
 * Development-only Vite integration for SnapEye.
 *
 * One plugin provides the whole V1 setup: local artifact storage, secure HTTP
 * middleware, and an automatically injected in-page client. No application
 * source file is modified and `apply: 'serve'` keeps it out of production.
 */
import { randomBytes } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS } from './core/protocol.js'
import { isValidName } from './core/ids.js'
import { hasAgentDoc } from './node/agent-doc.js'
import { createFsArtifactStore } from './node/fs-store.js'
import { ensureGitignore } from './node/gitignore.js'
import { pruneRuns } from './node/prune.js'
import { createSnapEyeHttpHandler } from './node/http-handler.js'

const PUBLIC_CLIENT_ID = 'virtual:@zumer/snapeye/client'
const RESOLVED_CLIENT_ID = `\0${PUBLIC_CLIENT_ID}`
const CLIENT_SOURCE_ID = 'virtual:@zumer/snapeye/internal-client-source'
const HTTP_STORE_SOURCE_ID = 'virtual:@zumer/snapeye/internal-http-store-source'

/**
 * Bare imports reachable only from the injected virtual module are invisible to
 * Vite's dependency scanner, which crawls the HTML entry. Without this list the
 * optimizer discovers them mid-request: the first page load can be served the
 * raw CommonJS build of `gifenc` (`ReferenceError: exports is not defined`) and
 * the whole in-page client dies before `window.snapeye` exists.
 */
const CLIENT_DEPENDENCIES = ['@zumer/snapdom', '@zumer/snapdiff/diff', 'gifenc']

const CLIENT_SOURCE_PATH = fileURLToPath(new URL('./client.js', import.meta.url))
const HTTP_STORE_SOURCE_PATH = fileURLToPath(new URL('./client/http-store.js', import.meta.url))

/**
 * @param {{root?: string, maxRuns?: number, client?: {forwardConsole?: boolean, errorOverlay?: boolean, hotkey?: string|false, hotkeyName?: string}}} [userOptions]
 * @returns {import('vite').Plugin}
 */
export function snapeye (userOptions = {}) {
  const options = normalizeOptions(userOptions)
  const token = randomBytes(32).toString('base64url')
  let config
  let store
  let initialization

  const initialize = async () => {
    if (initialization) return await initialization
    if (!store) throw new Error('SnapEye Vite plugin was not configured')

    initialization = (async () => {
      await assertSafeLayout(store)
      await store.ensureLayout()
      await assertSafeLayout(store)
      await ensureGitignore(store.paths.root)
      await pruneRuns({
        runsDir: store.paths.runs,
        maxRuns: options.maxRuns,
        log: message => config?.logger.info(`[snapeye] ${message}`)
      })
      // A coding agent does not find SnapEye on its own, and the failure is
      // silent: it does the task, verifies nothing, and says it looks fine.
      // This is the only thing the plugin nags about, and only while it is true.
      if (config && !await hasAgentDoc(config.root)) {
        config.logger.info(
          '[snapeye] your coding agent does not know SnapEye is here — run `npx snapeye init`'
        )
      }
    })()

    return await initialization
  }

  return {
    name: '@zumer/snapeye',
    apply: 'serve',

    config (userConfig) {
      const include = clientDependenciesToPrebundle(
        userConfig.root ? resolve(userConfig.root) : process.cwd()
      )
      return include.length ? { optimizeDeps: { include } } : null
    },

    configResolved (resolvedConfig) {
      config = resolvedConfig
      store = createFsArtifactStore({
        root: options.root,
        cwd: resolvedConfig.root
      })
    },

    resolveId (id) {
      if (id === PUBLIC_CLIENT_ID) return RESOLVED_CLIENT_ID
      if (id === CLIENT_SOURCE_ID) return CLIENT_SOURCE_PATH
      if (id === HTTP_STORE_SOURCE_ID) return HTTP_STORE_SOURCE_PATH
      return null
    },

    load (id) {
      if (id !== RESOLVED_CLIENT_ID) return null
      return buildInjectedClient({ token, endpoint: DEFAULTS.endpoint, client: options.client })
    },

    async configureServer (server) {
      await initialize()
      const handler = createSnapEyeHttpHandler({
        store,
        token,
        endpoint: DEFAULTS.endpoint,
        artifactRoot: options.root,
        artifactRootResolved: store.paths.root,
        log: message => server.config.logger.info(`[snapeye] ${message}`)
      })
      // Injection first, so it wraps the response before anything downstream
      // writes to it.
      server.middlewares.use(createHtmlInjector(() => clientTag(config?.base)))
      server.middlewares.use((req, res, next) => {
        handler(req, res, next).catch(error => {
          if (!res.headersSent) next(error)
          else res.destroy(error)
        })
      })
    },

    transformIndexHtml: {
      order: 'pre',
      handler (html) {
        if (html.includes('data-snapeye-client')) return null
        return [{
          tag: 'script',
          attrs: {
            type: 'module',
            src: virtualClientUrl(config?.base),
            'data-snapeye-client': ''
          },
          injectTo: 'head-prepend'
        }]
      }
    }
  }
}

const KNOWN_OPTIONS = new Set(['root', 'maxRuns', 'client'])
const KNOWN_CLIENT_OPTIONS = new Set(['forwardConsole', 'errorOverlay', 'hotkey', 'hotkeyName'])

/**
 * The injected client is off-by-default for everything that changes how the
 * application behaves. Zero setup must not mean a patched `console`, an
 * overlay on top of the page, or a key combination the app can no longer use;
 * each one is opted into explicitly through `snapeye({ client })`.
 */
const CLIENT_DEFAULTS = {
  forwardConsole: false,
  errorOverlay: false,
  hotkey: false
}

function normalizeOptions (options) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('snapeye() options must be an object')
  }
  assertKnownKeys(options, KNOWN_OPTIONS, 'snapeye()')

  const root = options.root ?? DEFAULTS.root
  const maxRuns = options.maxRuns ?? DEFAULTS.maxRuns
  if (typeof root !== 'string' || root.trim() === '' || root.includes('\0')) {
    throw new TypeError('snapeye() root must be a non-empty path')
  }
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 0) {
    throw new TypeError('snapeye() maxRuns must be a non-negative safe integer')
  }
  return { root, maxRuns, client: normalizeClientOptions(options.client) }
}

function normalizeClientOptions (client = {}) {
  if (client == null || typeof client !== 'object' || Array.isArray(client)) {
    throw new TypeError('snapeye() client options must be an object')
  }
  assertKnownKeys(client, KNOWN_CLIENT_OPTIONS, 'snapeye() client')

  const resolved = { ...CLIENT_DEFAULTS }
  for (const key of ['forwardConsole', 'errorOverlay']) {
    if (client[key] === undefined) continue
    if (typeof client[key] !== 'boolean') {
      throw new TypeError(`snapeye() client.${key} must be a boolean`)
    }
    resolved[key] = client[key]
  }

  if (client.hotkey !== undefined) {
    const hotkey = client.hotkey
    const isKey = typeof hotkey === 'string' && hotkey.length === 1 && /^[A-Za-z0-9]$/.test(hotkey)
    if (hotkey !== false && !isKey) {
      throw new TypeError('snapeye() client.hotkey must be false or a single alphanumeric character')
    }
    resolved.hotkey = hotkey
  }

  if (client.hotkeyName !== undefined) {
    if (!isValidName(client.hotkeyName)) {
      throw new TypeError('snapeye() client.hotkeyName must be a valid baseline name')
    }
    resolved.hotkeyName = client.hotkeyName
  }

  // Shift+<key> runs a real capture, which replaces a committable baseline.
  // Requiring the name up front keeps that from happening under a name the
  // developer never chose.
  if (resolved.hotkey !== false && resolved.hotkeyName === undefined) {
    resolved.hotkeyName = 'current'
  }
  return resolved
}

function assertKnownKeys (value, known, label) {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw new TypeError(`Unknown ${label} option: ${JSON.stringify(key)}`)
    }
  }
}

/**
 * Name each client dependency the way *this* project can resolve it: plain when
 * the package manager hoisted it, and through `@zumer/snapeye > dep` when it did
 * not (pnpm). Anything that resolves neither way is left out rather than handed
 * to Vite as an unresolvable include.
 */
function clientDependenciesToPrebundle (root) {
  const requireFromRoot = createRequire(join(root, 'noop.js'))
  const include = []
  for (const dependency of CLIENT_DEPENDENCIES) {
    if (canResolve(requireFromRoot, dependency)) include.push(dependency)
    else if (canResolve(requireFromRoot, '@zumer/snapeye/package.json')) {
      include.push(`@zumer/snapeye > ${dependency}`)
    }
  }
  return include
}

function canResolve (requireFrom, specifier) {
  try {
    requireFrom.resolve(specifier)
    return true
  } catch {
    return false
  }
}

function buildInjectedClient ({ token, endpoint, client }) {
  return [
    "import { snapdom } from '@zumer/snapdom'",
    `import { attachSnapEye } from ${JSON.stringify(CLIENT_SOURCE_ID)}`,
    `import { createHttpArtifactStore } from ${JSON.stringify(HTTP_STORE_SOURCE_ID)}`,
    `const endpoint = ${JSON.stringify(endpoint)}`,
    `const token = ${JSON.stringify(token)}`,
    `const client = ${JSON.stringify(client)}`,
    "const bootstrapKey = Symbol.for('@zumer/snapeye/vite-client')",
    'if (!globalThis[bootstrapKey]) {',
    '  const store = createHttpArtifactStore({ endpoint, token })',
    '  globalThis[bootstrapKey] = attachSnapEye({ ...client, snapdom, store, endpoint, token }) || true',
    '}'
  ].join('\n') + '\n'
}

/**
 * Inject the client into any HTML this dev server sends.
 *
 * `transformIndexHtml` only runs for HTML that Vite itself serves, which covers
 * a plain Vite app and nothing else. Astro, Nuxt, SvelteKit, Remix and Qwik
 * render their own pages, so that hook never fires for them and the client is
 * silently never installed: health answers `ok`, `window.snapeye` does not
 * exist, and every operation burns its whole timeout. One adapter per framework
 * would be a treadmill, and asking the agent to inject the client makes setup
 * every agent's problem.
 *
 * Every one of them does write its HTML through this response object, so the
 * tag goes in here — once, only into HTML, and only when it is not already
 * there (`transformIndexHtml` wins the race on a plain Vite app, and this sees
 * its marker and steps aside).
 *
 * Chunks are passed through as they come, so streamed SSR keeps streaming; only
 * the chunk that carries `<head>` is rewritten.
 */
function createHtmlInjector (buildTag) {
  return function snapEyeHtmlInjector (req, res, next) {
    if (!acceptsHtml(req)) return next()

    const originalWrite = res.write
    const originalEnd = res.end
    const originalWriteHead = res.writeHead
    let done = false
    let pending = ''
    let declaredType = ''

    // Headers passed to `writeHead()` are written straight to the socket and
    // never reach `getHeader()`, and that is how a framework-rendered page
    // announces itself. Reading only `getHeader()` sees nothing and skips every
    // page the injector exists for.
    res.writeHead = function (status, statusMessage, headers) {
      const map = (statusMessage && typeof statusMessage === 'object' ? statusMessage : headers) || null
      if (map && !Array.isArray(map)) {
        for (const key of Object.keys(map)) {
          const lower = key.toLowerCase()
          if (lower === 'content-type') declaredType = String(map[key])
          // Injecting adds bytes, so a declared length would contradict the
          // body. Dev servers stream HTML without one; drop it when present.
          if (lower === 'content-length' && isHtml(declaredType)) delete map[key]
        }
      }
      return originalWriteHead.apply(this, arguments)
    }

    const isHtmlResponse = () => isHtml(declaredType) || isHtml(res.getHeader('content-type'))

    // Adding bytes invalidates a declared length. Dev servers stream HTML
    // without one; when a framework does declare it, drop it rather than send a
    // response that contradicts its own header.
    const dropContentLength = () => {
      if (!res.headersSent) res.removeHeader('content-length')
    }

    const transform = (chunk, encoding) => {
      // A framework rendering through a web ReadableStream writes Uint8Array,
      // not Buffer. Checking only for Buffer let every Astro page through
      // untouched, which is the whole case this injector exists for.
      if (done || !isWritableChunk(chunk)) return chunk
      if (!isHtmlResponse()) { done = true; return chunk }

      const text = pending + decodeChunk(chunk, encoding)
      if (text.includes('data-snapeye-client')) { done = true; pending = ''; return text }

      const marker = /<head[^>]*>/i.exec(text)
      if (marker) {
        done = true
        pending = ''
        dropContentLength()
        const at = marker.index + marker[0].length
        return text.slice(0, at) + buildTag() + text.slice(at)
      }

      // `<head` may straddle two chunks. Hold back just enough to find it,
      // never the whole document.
      if (text.length < 2048) { pending = text; return '' }
      pending = text.slice(-16)
      return text.slice(0, -16)
    }

    res.write = function (chunk, encoding, callback) {
      const out = transform(chunk, encoding)
      if (out === '') {
        if (typeof callback === 'function') callback()
        else if (typeof encoding === 'function') encoding()
        return true
      }
      return originalWrite.call(this, out, typeof encoding === 'function' ? undefined : encoding, callback ?? (typeof encoding === 'function' ? encoding : undefined))
    }

    res.end = function (chunk, encoding, callback) {
      let out = chunk
      if (isWritableChunk(chunk)) out = transform(chunk, encoding)
      else if (pending) { out = pending; pending = '' }
      if (pending) { out = pending + (out || ''); pending = '' }
      res.write = originalWrite
      res.end = originalEnd
      res.writeHead = originalWriteHead
      return originalEnd.call(this, out, typeof encoding === 'function' ? undefined : encoding, callback ?? (typeof encoding === 'function' ? encoding : undefined))
    }

    next()
  }
}

function isWritableChunk (chunk) {
  return typeof chunk === 'string' || ArrayBuffer.isView(chunk)
}

function decodeChunk (chunk, encoding) {
  if (typeof chunk === 'string') return chunk
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    .toString(typeof encoding === 'string' ? encoding : 'utf8')
}

function isHtml (value) {
  return String(value || '').toLowerCase().includes('text/html')
}

function acceptsHtml (req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const accept = req.headers?.accept
  return typeof accept === 'string' && accept.includes('text/html')
}

function clientTag (base) {
  return `<script type="module" src="${virtualClientUrl(base)}" data-snapeye-client></script>`
}

function virtualClientUrl (base = '/') {
  const prefix = base === './' || base === '' ? '/' : base
  return `${prefix.replace(/\/$/, '')}/@id/${PUBLIC_CLIENT_ID}`
}

async function assertSafeLayout (store) {
  await assertPathType(store.paths.root, 'directory', true)
  await assertPathType(store.paths.baselines, 'directory', true)
  await assertPathType(store.paths.runs, 'directory', true)
  await assertPathType(join(store.paths.root, '.gitignore'), 'file', true)
}

async function assertPathType (path, expected, missingAllowed) {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if (missingAllowed && error?.code === 'ENOENT') return
    throw error
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`SnapEye refused a symbolic link at its ${expected} path`)
  }
  if (expected === 'directory' && !stats.isDirectory()) {
    throw new Error('SnapEye artifact layout contains a non-directory entry')
  }
  if (expected === 'file' && !stats.isFile()) {
    throw new Error('SnapEye .gitignore path is not a regular file')
  }
}

export { PUBLIC_CLIENT_ID, createHtmlInjector }
export default snapeye
