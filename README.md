# 👁 SnapEye

> **A tiny bridge that lets a coding agent _see_ your running web app.**
> snapDOM in the browser, a four-endpoint HTTP handler on the server,
> PNG + DOM + agent-map written to disk where any agent can `Read` them.

No headless browser. No Playwright. No baselines. No framework.
Just a contract.

---

## For the AI agent reading this

If you're an LLM coding agent (Claude Code, Cursor, Aider, OpenDevin, …)
landing in a repo that has SnapEye wired up, here's what you need:

**1. The contract — one GET + five POSTs under `/__snapeye__`:**

| Method | Path                              | Body              | Side effect                                                     |
|--------|-----------------------------------|-------------------|-----------------------------------------------------------------|
| GET    | `/__snapeye__/prev?name=X`        | —                 | Return bytes of `<dir>/X.png` (404 if none)                     |
| POST   | `/__snapeye__/snap?name=X`        | `image/png`       | Write `<dir>/X.png`                                             |
| POST   | `/__snapeye__/dom?name=X`         | `text/html`       | Write `<dir>/X.html`                                            |
| POST   | `/__snapeye__/map?name=X`         | `application/json`| Write `<dir>/X.png` + `<dir>/X.map.json`                        |
| POST   | `/__snapeye__/diff?name=X`        | `application/json`| Rotate `X.png→X.prev.png`, write `X.png` + `X.diff.png` + `X.diff.json` |
| POST   | `/__snapeye__/log`                | `text/plain`      | Echo to stdout as `[browser] …`                                 |

All endpoints accept `?namespace=NS` for multi-agent isolation
(output goes to `<dir>/NS/…`). `name` ∈ `[a-z0-9._-]`,
`namespace` ∈ `[a-z0-9_-]`.

**2. Triggers (no JS needed):**

```sh
# Capture the page as PNG + HTML
open "http://localhost:8080/?snap=home"

# Same, but with agent-map: numbered badges + JSON of interactive elements
open "http://localhost:8080/?snapmap=home"

# Capture + pixel-diff vs the previous capture for this name
open "http://localhost:8080/?snapdiff=home"

# Multi-agent: each agent uses its own namespace
open "http://localhost:8080/?snap=home&namespace=agent-a"
```

**3. Output files an agent can read:**

```
.snapeye/
├── home.png            ← raster capture (your Read tool can open this)
├── home.html           ← outerHTML at capture time
├── home.map.json       ← (if snapmap)  {map: [{i, n, r, b, s?}], dimensions}
├── home.prev.png       ← (if snapdiff) the previous capture, rotated aside
├── home.diff.png       ← (if snapdiff) red-overlay diff visualization
├── home.diff.json      ← (if snapdiff) {ratio, mismatched, totalPixels, dimsMatch, width, height}
└── agent-a/            ← (if namespace) per-agent subdir
    └── home.png
```

**4. Smoke test you can run to verify the loop:**

```sh
cd examples/standalone
node server.mjs &
open "http://localhost:8090/?snap=hello"
sleep 3
ls .snapeye/        # → hello.png  hello.html
```

If `hello.png` is missing, redirect stdout and look for `[browser] …`
lines — the console forwarder mirrors browser errors to the terminal.

**5. The agent-map JSON shape** (one entry per interactive element):

```json
{
  "dimensions": { "width": 1024, "height": 768 },
  "map": [
    { "i": 0, "n": "Sign in", "r": "button", "b": [120, 240, 80, 32] },
    { "i": 1, "n": "Email",   "r": "textbox", "b": [120, 180, 200, 32],
      "s": { "value": "user@example.com" } }
  ]
}
```

Keys: `i` index (matches the numbered badge in the PNG), `n` accessible
name, `r` ARIA role, `b` bbox `[x, y, w, h]` in image pixels, `s`
optional state (`checked`, `disabled`, `expanded`, `pressed`, `value`,
`covered`, …). When the model decides "click 3", the bbox of entry 3
gives the coordinates.

---

## Why this exists

Coding agents can read files but not look at a browser. The result: a
category of bugs they're blind to — layout drift, broken theming,
components rendered at 0×0 because of a CSS regression. They write code,
you re-load, they ask you what they see.

SnapEye closes that loop without any of the heavy machinery (Playwright,
headless Chromium, baseline diff systems). The page captures itself with
[`@zumer/snapdom`](https://github.com/zumerlab/snapdom) and POSTs the
result back to the dev server, which drops files where the agent can
`Read` them.

It is **not** a visual-regression tool (use
[`@zumer/snapdiff`](https://github.com/zumerlab/snapdiff) for that, on
top of SnapEye), and it is **not** a screenshot service (use Playwright
if you need pixel fidelity). It is the smallest possible bridge that
gives an agent eyes — and, with `agent-map`, hands.

---

## Install

```sh
npm install --save-dev @zumer/snapeye @zumer/snapdom
```

`@zumer/snapdom` is a peer dependency (>= 2.12). Bring your own copy.

---

## Setup

**Browser** — anywhere in your app:

```js
import { snapdom }       from '@zumer/snapdom'
import { attachSnapEye } from '@zumer/snapeye/client'

attachSnapEye({ snapdom })
```

**Server** — your dev server, whatever it is:

```js
import { createServer } from 'node:http'
import { createSnapEyeHandler } from '@zumer/snapeye/server'

const snapEye = createSnapEyeHandler({ dir: '.snapeye' })

createServer(async (req, res) => {
  if (await snapEye(req, res)) return
  // … your own routing …
}).listen(8080)
```

That's it. Hit `http://localhost:8080/?snap=home`, then read
`.snapeye/home.png`. From inside the app:

```js
window.snapeye.snap('hero')
window.snapeye.snap('checkout-step-2', document.querySelector('.checkout'))
```

Or press <kbd>Shift+S</kbd>.

---

## agent-map: from sight to action

Plain `snap` gives the agent eyes. `snapMap` gives it numbered handles
on every interactive element so it can describe actions ("click 3") with
unambiguous coordinates. It uses snapdom's official `agent-map` plugin
(ships in [`@zumer/snapdom-plugins`](https://github.com/zumerlab/snapdom/tree/main/packages/plugins),
a separate, optional package).

**Install** the plugins package alongside snapeye:

```sh
npm install --save-dev @zumer/snapdom-plugins
```

**Browser**:

```js
import { snapdom }       from '@zumer/snapdom'
import { agentMap }      from '@zumer/snapdom-plugins/agent-map'
import { attachSnapEye } from '@zumer/snapeye/client'

attachSnapEye({
  snapdom,
  agentMap,                                  // pass the plugin factory
  agentMapOptions: { fields: 'minimal' }     // forwarded to agentMap()
})

// Trigger it:
window.snapeye.snapMap('login')
// or open http://localhost:8080/?snapmap=login
```

**Output**: `.snapeye/login.png` (with red numbered badges) and
`.snapeye/login.map.json` (the structured map). The agent reads the PNG
to see, then the JSON to act.

See agent-map's docstring for all options (`image`, `fields`,
`semantic`, `maxImageWidth`, …).

---

## snapDiff: iteration mode

When an agent iterates on a UI change (edit CSS → reload → look → edit
again), the question that matters isn't "what does the page look like
now" but "what changed since my last capture". `snapDiff` answers that.

Each call:

1. captures the current view,
2. pixel-diffs it against the previous capture saved under the same name
   (using [`@zumer/snapdiff`](https://github.com/zumerlab/snapdiff)'s
   browser-side YIQ pixel-diff engine — no headless browser, no native
   binary),
3. writes four files: the new `<name>.png`, the old one rotated to
   `<name>.prev.png`, a red-overlay `<name>.diff.png`, and a
   `<name>.diff.json` with `ratio` / `mismatched` / `dimsMatch`.

The first ever call for a name has no baseline — snapeye just writes
`<name>.png` and reports `hasBaseline: false`. Subsequent calls produce
the full set.

**Install** snapdiff alongside snapeye:

```sh
npm install --save-dev @zumer/snapdiff
```

**Browser**:

```js
import { snapdom }       from '@zumer/snapdom'
import { diffCanvas }    from '@zumer/snapdiff/diff'
import { attachSnapEye } from '@zumer/snapeye/client'

attachSnapEye({ snapdom, diffCanvas })

// Trigger it:
window.snapeye.snapDiff('home')
// or open http://localhost:8080/?snapdiff=home
```

Returns `{ name, hasBaseline, ratio, mismatched, totalPixels, dimsMatch, width, height }`.
For the agent, the useful number is `ratio` (0 means pixel-identical,
0.01 means 1% of pixels differ). `dimsMatch: false` is a layout
regression worth flagging on its own.

You can combine modes: `agentMap` and `diffCanvas` can both be passed,
and `snap` / `snapMap` / `snapDiff` then coexist on `window.snapeye`.

---

## Multi-agent: namespaces

Multiple agents driving the same app in parallel will clobber each
other's files unless they namespace. Two ways to opt in:

**Per-agent server instance** (simplest):

```js
const snapEye = createSnapEyeHandler({
  dir: '.snapeye',
  namespace: process.env.AGENT_ID    // e.g. 'agent-a'
})
```

**Per-request** (one server, many agents):

```sh
open "http://localhost:8080/?snap=home&namespace=agent-a"
open "http://localhost:8080/?snap=home&namespace=agent-b"
```

Either way, files land in `.snapeye/agent-a/home.png` and
`.snapeye/agent-b/home.png`. Empty namespace (`''`, the default) keeps
the original flat layout.

---

## Framework integration

The handler is a `(req, res) => Promise<boolean>` — it returns `true` if
it owned the request.

### Express / Connect

```js
app.use(async (req, res, next) => {
  if (!(await snapEye(req, res))) next()
})
```

### Vite

```js
// vite.config.js
import { createSnapEyeHandler } from '@zumer/snapeye/server'

export default {
  plugins: [{
    name: 'snapeye',
    configureServer (server) {
      const handler = createSnapEyeHandler({ dir: '.snapeye' })
      server.middlewares.use(async (req, res, next) => {
        if (!(await handler(req, res))) next()
      })
    }
  }]
}
```

### Hono / Bun

```js
const snapEye = createSnapEyeHandler({ dir: '.snapeye' })
app.all('/__snapeye__/*', async (c) => {
  const handled = await snapEye(c.req.raw, c.res)
  return handled ? c.body(null) : c.notFound()
})
```

---

## Client options

```js
attachSnapEye({
  snapdom,                         // required
  agentMap: null,                  // plugin factory → enables snapMap
  diffCanvas: null,                // function from @zumer/snapdiff/diff → enables snapDiff
  namespace: '',                   // appended as ?namespace=X to every POST
  endpoint: '/__snapeye__',        // must match server prefix
  autoOnQuery: true,               // ?snap / ?snapmap / ?snapdiff auto-trigger
  forwardConsole: true,            // mirror console.* to /log
  errorOverlay: true,              // top-bar overlay for window.onerror
  defaultTarget: () => document.documentElement,
  hideSelectors: ['.dev-only'],    // hidden during capture
  snapdomOptions: { dpr: 1, scale: 1 },
  agentMapOptions: {},             // forwarded to agentMap()
  hotkey: 'S'                      // null to disable; Shift + key
})
```

Returns `{ snap, snapMap, snapDiff, log, options }`. Also attached as
`window.snapeye`.

---

## Server options

```js
createSnapEyeHandler({
  dir: '.snapeye',                 // output directory (relative to cwd)
  prefix: '/__snapeye__',
  namespace: '',                   // default; ?namespace=X overrides per-request
  log: (line) => console.log(line),// pass null to silence
  onSnap: ({ name, namespace, path, bytes }) => {},
  onMap:  ({ name, namespace, jsonPath, pngPath, marks }) => {},
  onDiff: ({ name, namespace, curPath, prevPath, diffPath, jsonPath, stats }) => {},
  onLog:  ({ line, namespace }) => {}
})
```

---

## Iterating from an agent

A typical loop for a coding agent driving the project:

```bash
# 1. Restart dev server (fresh state, no stale captures)
pkill -f "your-dev-server" || true
rm -rf .snapeye
npm run dev > /tmp/dev.log 2>&1 &

# 2. Trigger a capture
open "http://localhost:8080/?snap=home"

# 3. Wait, then read the result
sleep 2
# (the agent does: Read .snapeye/home.png)
```

For multi-route capture, drive the navigation yourself inside the app
(`router.push(route)` → `window.snapeye.snap(route.name)` →
`afterRender` → next). SnapEye intentionally does **not** know how
your app navigates.

For act-mode (the agent will click / type / etc.), use `snapMap`
instead — the JSON map plus the annotated PNG give the agent both
visual context and unambiguous coordinates.

For iteration-mode (the agent makes a change, captures, makes another
change, captures again), use `snapDiff`. The agent then reads
`<name>.diff.json` to get a single number — `ratio` — that tells it
whether the last edit changed anything visible. Below some threshold,
it can ignore; above, it reads `<name>.diff.png` to see *where*.

---

## What it does not do

- **No diff engine in this repo.** The pixel-diff math lives in
  `@zumer/snapdiff` (peer dep, loaded only if you opt in to `snapDiff`).
  SnapEye's `/diff` endpoint just stores what the browser computed.
- **No navigation logic.** The client exposes `snap`, `snapMap` and
  `snapDiff` — the consumer decides when to call them.
- **No headless mode.** A tab needs to be open. For CI, drive a headless
  browser yourself (Playwright/Puppeteer) — they speak the same HTTP
  contract.
- **No auth.** The endpoints are unauthenticated. Mount them only on
  your local dev server.
- **No bundler.** Hand-written ESM, zero deps.

---

## License

[MIT](LICENSE) · © Juan Martín Muda · [Zumerlab](https://github.com/zumerlab)
