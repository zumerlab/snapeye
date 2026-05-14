/**
 * SnapEye client — runs in the browser, captures the DOM with snapDOM,
 * and POSTs PNG / HTML / log lines to the SnapEye server handler.
 *
 * Designed for one purpose: let a coding agent (Claude Code, Cursor,
 * Aider, …) see what's on screen by reading files from disk.
 *
 *   import { snapdom } from '@zumer/snapdom'
 *   import { attachSnapEye } from '@zumer/snapeye/client'
 *   const eye = attachSnapEye({ snapdom })
 *   eye.snap('home')
 *
 * The contract is intentionally tiny — three POST endpoints. Any web
 * stack can expose them (see ../server.js for a Node-http handler).
 */

const DEFAULTS = {
  /** snapDOM module (snapdom function). Required. */
  snapdom: null,
  /**
   * Optional agentMap plugin factory from `@zumer/snapdom-plugins/agent-map`.
   * When provided, `snapMap(name)` and `?snapmap=NAME` capture a Set-of-Mark
   * package (numbered badges + JSON bbox/role map) for visual agents.
   */
  agentMap: null,
  /**
   * Optional `diffCanvas` function from `@zumer/snapdiff/diff`. When
   * provided, `snapDiff(name)` and `?snapdiff=NAME` capture and pixel-diff
   * against the previous capture saved on disk, writing a diff PNG and
   * stats alongside the current.
   */
  diffCanvas: null,
  /** Prefix used on every endpoint. Server must match. */
  endpoint: '/__snapeye__',
  /**
   * Namespace appended as `?namespace=X` to every POST. Lets multiple
   * agents capture in parallel against the same server without clobbering
   * files. Server writes them under `<dir>/<namespace>/`.
   */
  namespace: '',
  /** Auto-trigger snap when URL contains `?snap=NAME` (or `?snap=current`). */
  autoOnQuery: true,
  /** Mirror console.log/.warn/.error to the server log endpoint. */
  forwardConsole: true,
  /** Show a top-bar overlay when a JS error or rejection fires. */
  errorOverlay: true,
  /** Element to capture when no explicit target is given. */
  defaultTarget: () => document.documentElement,
  /** Hide these selectors during capture (restored after). */
  hideSelectors: [],
  /** Extra options forwarded to snapdom.toBlob(). */
  snapdomOptions: { type: 'png', dpr: 1, scale: 1, embedFonts: false },
  /** Options forwarded to the agentMap() plugin factory. */
  agentMapOptions: {},
  /** Hotkey to snap the current view (Shift + this key). null to disable. */
  hotkey: 'S'
}

function safeName (s) {
  return String(s || `snap-${Date.now()}`).replace(/[^a-z0-9._-]/gi, '_')
}

export function attachSnapEye (userOpts = {}) {
  const opts = { ...DEFAULTS, ...userOpts }
  if (!opts.snapdom) throw new Error('snapeye: pass `snapdom` option (the snapdom function)')

  function withNs (path) {
    if (!opts.namespace) return path
    const sep = path.includes('?') ? '&' : '?'
    return `${path}${sep}namespace=${encodeURIComponent(opts.namespace)}`
  }
  const url = (path) => `${opts.endpoint}/${withNs(path)}`

  async function post (path, body, headers = {}) {
    try {
      const r = await fetch(url(path), { method: 'POST', body, headers })
      return r.ok
    } catch { return false }
  }

  function hide () {
    const hidden = []
    opts.hideSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        hidden.push([el, el.style.display]); el.style.display = 'none'
      })
    })
    return () => hidden.forEach(([el, d]) => { el.style.display = d })
  }

  async function snap (name, target) {
    name = safeName(name)
    target = target || opts.defaultTarget()
    const restore = hide()
    try {
      const blob = await opts.snapdom.toBlob(target, opts.snapdomOptions)
      await post(`snap?name=${encodeURIComponent(name)}`, blob, { 'content-type': 'image/png' })
      // Also dump the DOM HTML — useful when the image looks wrong.
      if (target instanceof Element) {
        await post(`dom?name=${encodeURIComponent(name)}`, target.outerHTML, { 'content-type': 'text/html' })
      }
      return { name }
    } finally {
      restore()
    }
  }

  async function blobToCanvas (blob) {
    const objUrl = URL.createObjectURL(blob)
    try {
      const img = new Image()
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = objUrl })
      const c = document.createElement('canvas')
      c.width = img.naturalWidth; c.height = img.naturalHeight
      c.getContext('2d').drawImage(img, 0, 0)
      return c
    } finally { URL.revokeObjectURL(objUrl) }
  }

  /**
   * Capture a Set-of-Mark package: annotated PNG (numbered badges on
   * interactive elements) + JSON bbox/role/state map. Requires `agentMap`
   * to have been passed in options. POSTs to /map as one JSON request.
   */
  async function snapMap (name, target) {
    if (!opts.agentMap) {
      throw new Error('snapeye: pass `agentMap` option (the plugin factory from @zumer/snapdom-plugins/agent-map) to use snapMap')
    }
    name = safeName(name)
    target = target || opts.defaultTarget()
    const restore = hide()
    try {
      const result = await opts.snapdom(target, {
        ...opts.snapdomOptions,
        plugins: [opts.agentMap(opts.agentMapOptions)]
      })
      const out = await result.toAgentMap()
      await post(
        `map?name=${encodeURIComponent(name)}`,
        JSON.stringify(out),
        { 'content-type': 'application/json' }
      )
      return { name, marks: out.map.length }
    } finally {
      restore()
    }
  }

  /**
   * Capture and pixel-diff against the previous capture for this name.
   *   1. capture current with snapdom
   *   2. GET /prev?name=X → load previous PNG, if any
   *   3. if no prev: behave like snap() — establish the baseline
   *   4. if prev:    run diffCanvas(prev, current), POST {image, diff, stats}
   * The server rotates the existing <name>.png → <name>.prev.png and writes
   * <name>.png (new), <name>.diff.png, <name>.diff.json.
   * Requires `diffCanvas` option (from @zumer/snapdiff/diff).
   */
  async function snapDiff (name, target) {
    if (!opts.diffCanvas) {
      throw new Error('snapeye: pass `diffCanvas` option (from @zumer/snapdiff/diff) to use snapDiff')
    }
    name = safeName(name)
    target = target || opts.defaultTarget()
    const restore = hide()
    try {
      const blob = await opts.snapdom.toBlob(target, opts.snapdomOptions)
      const curCanvas = await blobToCanvas(blob)

      // Pull the previous capture (may be 404 on first call).
      let prevCanvas = null
      try {
        const r = await fetch(url(`prev?name=${encodeURIComponent(name)}`))
        if (r.ok) prevCanvas = await blobToCanvas(await r.blob())
      } catch { /* network blip — treat as no prev */ }

      if (!prevCanvas) {
        // First time we see this name: just establish the baseline.
        await post(`snap?name=${encodeURIComponent(name)}`, blob, { 'content-type': 'image/png' })
        return { name, hasBaseline: false, ratio: 0, mismatched: 0 }
      }

      const out = opts.diffCanvas(prevCanvas, curCanvas)
      const stats = {
        ratio: out.ratio,
        mismatched: out.mismatched,
        totalPixels: out.totalPixels,
        dimsMatch: out.dimsMatch,
        width: out.width,
        height: out.height
      }
      await post(
        `diff?name=${encodeURIComponent(name)}`,
        JSON.stringify({
          image: curCanvas.toDataURL('image/png'),
          diff:  out.canvas.toDataURL('image/png'),
          stats
        }),
        { 'content-type': 'application/json' }
      )
      return { name, hasBaseline: true, ...stats }
    } finally {
      restore()
    }
  }

  function log (level, ...args) {
    if (!opts.forwardConsole) return
    const body = args.map(a => {
      if (a instanceof Error) return a.stack || a.message
      if (typeof a === 'object') { try { return JSON.stringify(a) } catch { return String(a) } }
      return String(a)
    }).join(' ')
    post('log', `[${level}] ${body}`, { 'content-type': 'text/plain' })
  }

  // ── Console mirror ───────────────────────────────────────────────────
  if (opts.forwardConsole) {
    ;['log', 'warn', 'error', 'info'].forEach(method => {
      const orig = console[method] && console[method].bind(console)
      if (!orig) return
      console[method] = (...args) => { orig(...args); log(method, ...args) }
    })
  }

  // ── Error overlay ────────────────────────────────────────────────────
  let errBox
  function showErr (msg) {
    if (!opts.errorOverlay) return
    if (!errBox) {
      errBox = Object.assign(document.createElement('div'), {
        id: '__snapeye_err__',
        style: 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#c0392b;color:#fff;font:13px/1.4 ui-monospace,Menlo,monospace;padding:10px 16px;max-height:40vh;overflow:auto;white-space:pre-wrap;'
      })
      const close = Object.assign(document.createElement('span'), {
        textContent: '×', style: 'float:right;cursor:pointer;opacity:.7;padding:0 8px'
      })
      close.onclick = () => errBox.remove()
      errBox.appendChild(close)
      document.body.appendChild(errBox)
    }
    errBox.appendChild(Object.assign(document.createElement('div'), { textContent: msg }))
    post('log', `[error] ${msg}`, { 'content-type': 'text/plain' })
  }
  if (opts.errorOverlay) {
    window.addEventListener('error', e => showErr(`ERROR: ${e.message} (${e.filename}:${e.lineno})`))
    window.addEventListener('unhandledrejection', e => showErr(`PROMISE: ${e.reason?.stack || e.reason || e}`))
  }

  // ── Hotkey ───────────────────────────────────────────────────────────
  if (opts.hotkey) {
    document.addEventListener('keydown', e => {
      if (e.shiftKey && e.key === opts.hotkey) { e.preventDefault(); snap() }
    })
  }

  // ── URL auto-triggers: ?snap, ?snapmap, ?snapdiff, ?namespace ────────
  if (opts.autoOnQuery) {
    const q = new URL(location.href).searchParams
    // If the URL carries ?namespace=NS, route all POSTs from this tab
    // through that namespace — that's how per-request multi-agent works.
    const nsParam = q.get('namespace')
    if (nsParam) opts.namespace = nsParam
    const snapParam = q.get('snap')
    const mapParam  = q.get('snapmap')
    const diffParam = q.get('snapdiff')
    if (snapParam) setTimeout(() => snap(snapParam === '1' ? 'current' : snapParam), 600)
    if (mapParam)  setTimeout(() => snapMap(mapParam === '1' ? 'current' : mapParam), 600)
    if (diffParam) setTimeout(() => snapDiff(diffParam === '1' ? 'current' : diffParam), 600)
  }

  const api = { snap, snapMap, snapDiff, log, options: opts }
  if (typeof window !== 'undefined') window.snapeye = api
  return api
}

export default attachSnapEye
