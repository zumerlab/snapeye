/**
 * Standalone host: serve one HTML file, or a directory, with the SnapEye Vite
 * plugin and no project dev server.
 *
 * The case is an issue repro or a scratch page: a single HTML file that loads
 * SnapDOM from a CDN and has no build of its own. Vite already knows how to
 * serve a directory, inject the client, and run the plugin, so this is the
 * plugin applied to a folder — not a second host adapter. What a folder cannot
 * provide is `node_modules`: the injected client imports `@zumer/snapdom`,
 * `@zumer/snapdiff/diff` and `gifenc` by bare name, and a scratch directory has
 * nothing to resolve them against. Each one is therefore aliased to the file
 * this installed copy of SnapEye resolves, and dependency discovery is turned
 * off so nothing is pre-bundled mid-request.
 *
 * `--snapdom <path>` points the client (and any CDN `<script>` on the page) at a
 * local SnapDOM build instead of the installed package, which is how a fix is
 * verified before it is published.
 */
import { createRequire } from 'node:module'
import { realpathSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS } from '../core/protocol.js'
import { snapeye } from '../vite.js'

const require = createRequire(import.meta.url)
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** `<script src="https://unpkg.com/@zumer/snapdom[@x.y.z][/dist/snapdom.js]">` and the jsDelivr spelling. */
const CDN_SNAPDOM_SCRIPT = /(<script\b[^>]*\bsrc=["'])(?:https?:)?\/\/(?:unpkg\.com|cdn\.jsdelivr\.net\/npm)\/@zumer\/snapdom(?:@[^/"']*)?(\/[^"']*)?(["'])/gi

/**
 * @param {object} options
 * @param {string} options.entry HTML file or directory to serve
 * @param {string|null} [options.snapdom] local SnapDOM build: `dist/`, `snapdom.mjs`, or `snapdom.js`
 * @param {number} [options.port] 0 picks a free port
 * @param {string} [options.host]
 * @param {string} [options.root] artifact root, resolved against `cwd`
 * @param {string} [options.cwd]
 * @param {string} [options.logLevel] Vite log level
 * @returns {Promise<{url: string, origin: string, artifactRoot: string, dir: string, snapdom: {esm: string, iife: string|null}|null, close: () => Promise<void>}>}
 */
export async function startStandaloneServer ({
  entry,
  snapdom = null,
  port = 0,
  host = '127.0.0.1',
  root = DEFAULTS.root,
  cwd = process.cwd(),
  logLevel = 'silent'
} = {}) {
  const page = await resolveEntry(entry, cwd)
  const build = snapdom ? await resolveSnapdomBuild(snapdom, cwd) : null
  const vite = await loadVite()
  const artifactRoot = isAbsolute(root) ? resolve(root) : resolve(cwd, root)

  const aliases = {
    '@zumer/snapdom': build ? build.esm : resolveClientDependency('@zumer/snapdom'),
    '@zumer/snapdiff/diff': resolveClientDependency('@zumer/snapdiff/diff'),
    gifenc: resolveClientDependency('gifenc')
  }

  const plugin = snapeye({ root: artifactRoot })
  // Every client dependency is aliased to a file above, so there is nothing to
  // pre-bundle. The plugin's `config` hook would still ask Vite to, resolving
  // from a directory that has no node_modules; drop it here.
  plugin.config = undefined

  const server = await vite.createServer({
    root: page.dir,
    configFile: false,
    envFile: false,
    logLevel,
    clearScreen: false,
    resolve: {
      alias: Object.entries(aliases).map(([find, replacement]) => ({
        find: new RegExp(`^${escapeRegExp(find)}$`),
        replacement
      }))
    },
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [plugin, build ? localSnapdomPlugin(build) : null].filter(Boolean),
    server: {
      host,
      port,
      strictPort: port !== 0,
      open: false,
      fs: {
        allow: [
          page.dir,
          PACKAGE_ROOT,
          ...Object.values(aliases).map(file => dirname(file)),
          ...(build ? [build.dir] : [])
        ]
      }
    }
  })
  await server.listen()

  const local = server.resolvedUrls?.local?.[0]
  const origin = (local || `http://${host}:${server.config.server.port}/`).replace(/\/+$/, '')
  const url = page.file ? `${origin}/${encodeURIComponent(page.file)}` : `${origin}/`

  return {
    url,
    origin,
    artifactRoot,
    dir: page.dir,
    snapdom: build,
    close: () => server.close()
  }
}

/**
 * A local SnapDOM build has two faces: `snapdom.mjs` for the injected client's
 * import, and `snapdom.js` (IIFE) for a page that loads it from a CDN `<script>`.
 * Accept the `dist/` directory, a package root, or either file, and find the
 * sibling; the ESM build is required because the client cannot work without it.
 *
 * @param {string} input
 * @param {string} cwd
 * @returns {Promise<{dir: string, esm: string, iife: string|null}>}
 */
export async function resolveSnapdomBuild (input, cwd = process.cwd()) {
  const path = resolve(cwd, input)
  const stats = await lstat(path).catch(() => null)
  if (!stats) throw new Error(`SnapDOM build not found: ${path}`)

  let esm = null
  let iife = null
  if (stats.isDirectory()) {
    esm = await firstFile([join(path, 'snapdom.mjs'), join(path, 'dist', 'snapdom.mjs')])
    iife = await firstFile([join(path, 'snapdom.js'), join(path, 'dist', 'snapdom.js')])
  } else if (extname(path) === '.mjs') {
    esm = path
    iife = await firstFile([join(dirname(path), 'snapdom.js')])
  } else {
    iife = path
    esm = await firstFile([join(dirname(path), 'snapdom.mjs')])
  }
  if (!esm) {
    throw new Error(`No ESM SnapDOM build (snapdom.mjs) found at ${path}; the in-page client imports it`)
  }
  return { dir: dirname(esm), esm, iife }
}

/**
 * Point the page's own CDN `<script>` at the local build too, so the page and
 * the SnapEye client run the same SnapDOM. A `.mjs` request maps to the ESM
 * build, anything else to the IIFE; a missing IIFE leaves the tag untouched.
 */
function localSnapdomPlugin (build) {
  return {
    name: '@zumer/snapeye:local-snapdom',
    transformIndexHtml: {
      order: 'pre',
      handler (html) {
        return html.replace(CDN_SNAPDOM_SCRIPT, (match, open, path = '', close) => {
          const file = /\.mjs$/i.test(path) ? build.esm : build.iife
          if (!file) return match
          return `${open}${fsUrl(file)}${close}`
        })
      }
    }
  }
}

/** Vite's URL for a file outside the root: `/@fs/` plus the absolute path. */
function fsUrl (file) {
  return `/@fs/${file.replace(/\\/g, '/').replace(/^\//, '')}`
}

async function resolveEntry (entry, cwd) {
  if (typeof entry !== 'string' || entry.trim() === '') throw new Error('An HTML file or directory to serve is required')
  const path = resolve(cwd, entry)
  const stats = await lstat(path).catch(() => null)
  if (!stats) throw new Error(`Nothing to serve at ${path}`)
  if (stats.isDirectory()) return { dir: path, file: null }
  if (!stats.isFile() || !/\.html?$/i.test(path)) throw new Error(`Expected an .html file or a directory, got ${path}`)
  return { dir: dirname(path), file: basename(path) }
}

/**
 * The file this installed SnapEye would import for a client dependency, read
 * from the package's own manifest: `exports` for the scoped packages, and the
 * `module` entry for `gifenc`, whose `main` is the CommonJS build the browser
 * cannot run. (`import.meta.resolve` would do for the first two, but it does
 * not exist under every loader this file runs in.)
 */
function resolveClientDependency (specifier) {
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
  const manifest = findManifest(name)
  if (!manifest) throw new Error(`Could not find the ${name} package next to SnapEye`)
  const { dir, json } = manifest
  if (name === 'gifenc') return resolve(dir, json.module || json.main)

  const subpath = `.${specifier.slice(name.length)}`
  const entry = json.exports?.[subpath]
  const file = typeof entry === 'string' ? entry : entry?.import || entry?.default || entry?.browser
  if (typeof file === 'string') return resolve(dir, file)
  if (subpath === '.' && (json.module || json.main)) return resolve(dir, json.module || json.main)
  throw new Error(`Could not resolve ${specifier} from ${dir}`)
}

/**
 * A package's directory and manifest, found the way Node would but without
 * going through `exports` (which rarely lists package.json). The realpath
 * keeps pnpm's symlinked layout honest.
 */
function findManifest (name) {
  for (const directory of require.resolve.paths(name) || []) {
    const file = join(directory, name, 'package.json')
    try {
      return { dir: realpathSync(dirname(file)), json: require(file) }
    } catch {}
  }
  return null
}

async function loadVite () {
  try {
    return await import('vite')
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    const problem = new Error('vite is not installed')
    problem.hint = 'The standalone server is Vite with the SnapEye plugin. Install it: npm install --save-dev vite'
    throw problem
  }
}

async function firstFile (candidates) {
  for (const candidate of candidates) {
    const stats = await lstat(candidate).catch(() => null)
    if (stats?.isFile()) return candidate
  }
  return null
}

function escapeRegExp (value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
