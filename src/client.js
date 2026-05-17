/**
 * SnapEye client — runs in the browser, captures the DOM with snapDOM,
 * and POSTs the PNG (plus any console output) to the SnapEye server.
 *
 * Designed for one purpose: let a coding agent (Claude Code, Cursor,
 * Aider, …) see what's on screen by reading files from disk.
 *
 *   import { snapdom } from '@zumer/snapdom'
 *   import { attachSnapEye } from '@zumer/snapeye/client'
 *   const eye = attachSnapEye({ snapdom })
 *   eye.snap('home')
 *
 * The contract is intentionally tiny — two POST endpoints. Any web
 * stack can expose them (see ../server.js for a Node-http handler).
 */

const DEFAULTS = {
  /** snapDOM module (snapdom function). Required. */
  snapdom: null,
  /** Prefix used on every endpoint. Server must match. */
  endpoint: '/__snapeye__',
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
  /** Hotkey to snap the current view (Shift + this key). null to disable. */
  hotkey: 'S'
}

function safeName (s) {
  return String(s || `snap-${Date.now()}`).replace(/[^a-z0-9._-]/gi, '_')
}

export function attachSnapEye (userOpts = {}) {
  const opts = { ...DEFAULTS, ...userOpts }
  if (!opts.snapdom) throw new Error('snapeye: pass `snapdom` option (the snapdom function)')

  const url = (path) => `${opts.endpoint}/${path}`

  async function post (path, body, headers = {}) {
    try {
      const r = await fetch(url(path), { method: 'POST', body, headers })
      return r.ok
    } catch { return false }
  }

  async function snap (name, target) {
    name = safeName(name)
    target = target || opts.defaultTarget()

    // Stash hidden selectors so they don't pollute the capture.
    const hidden = []
    opts.hideSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        hidden.push([el, el.style.display]); el.style.display = 'none'
      })
    })

    try {
      const blob = await opts.snapdom.toBlob(target, opts.snapdomOptions)
      await post(`snap?name=${encodeURIComponent(name)}`, blob, { 'content-type': 'image/png' })
      return { name }
    } finally {
      hidden.forEach(([el, d]) => { el.style.display = d })
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

  // ── ?snap=NAME auto-trigger ──────────────────────────────────────────
  if (opts.autoOnQuery) {
    const param = new URL(location.href).searchParams.get('snap')
    if (param) setTimeout(() => snap(param === '1' ? 'current' : param), 600)
  }

  const api = { snap, log, options: opts }
  if (typeof window !== 'undefined') window.snapeye = api
  return api
}

export default attachSnapEye
