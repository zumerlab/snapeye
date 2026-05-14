# SnapEye — agent / dev context

Read this before changing anything in this repo.

## Origin

SnapEye was extracted from `/Users/martin/GitHub/zircleUI`. While
rebuilding zircle 2.x on top of Orbit + Zumly, the agent driving the
project (a coding agent that can read images but not look at a browser)
needed a way to *see* the rendered output. The team wired up snapDOM in
the page + three POST endpoints in the dev server + a `.snapeye/` dir
that the agent could `Read`. That ad-hoc pattern lived in
`zircleUI/src/demo/snap.js` and `zircleUI/scripts/dev.mjs`.

SnapEye is that pattern, pulled into its own package, with nothing else
added. The original wiring is still in zircleUI for reference.

## What we explicitly decided NOT to do

These came up while building it. They are deliberately out of scope.

- **No diff engine in this repo.** The pixel diff is `@zumer/snapdiff`,
  a peer dep. SnapEye's `/diff` endpoint just stores what the browser
  computed (current PNG, diff PNG, stats JSON) and handles the
  rotation of `X.png → X.prev.png`. The diff math lives in snapdiff.
- **No navigation logic.** The client does not know how your app routes.
  It exposes `snap(name, target?)`. The consumer decides when to call it.
- **No framework integration packaged here.** The handler is
  `(req, res) => Promise<boolean>`. Wrappers for Vite/Express/Hono are
  3–5 lines documented in the README. If we ever publish dedicated
  adapter packages, they live in separate repos.
- **No auth.** Endpoints are unauthenticated. Mount on localhost only.
- **No headless mode in the package.** A consumer can drive a headless
  browser (Playwright) themselves — the contract is HTTP, so it doesn't
  matter who's the client.
- **No bundler.** Hand-written ESM. The library is small enough that a
  build step would cost more than it saves. Type definitions can ship
  later as a `.d.ts` if there's demand.

## The contract (don't break this)

One GET + five POSTs under a configurable prefix (default `/__snapeye__`):

```
GET   /__snapeye__/prev?name=X                       → bytes of <dir>/X.png (404 if none)
POST  /__snapeye__/snap?name=X    image/png          → <dir>/X.png
POST  /__snapeye__/dom?name=X     text/html          → <dir>/X.html
POST  /__snapeye__/map?name=X     application/json   → <dir>/X.png + <dir>/X.map.json
POST  /__snapeye__/diff?name=X    application/json   → rotate X.png→X.prev.png, write X.png + X.diff.png + X.diff.json
POST  /__snapeye__/log            text/plain         → stdout `[browser] …`
```

Every endpoint accepts an optional `?namespace=NS` query param. When
present (or when the handler is created with `namespace: 'NS'`), output
is nested under `<dir>/NS/…`. This is the multi-agent isolation seam —
two agents can capture in parallel without clobbering each other.

`name` is sanitized to `[a-z0-9._-]`. Anything outside that gets
replaced with `_`, and missing names fall back to `snap-<timestamp>`.
`namespace` is sanitized to `[a-z0-9_-]` (no dots — prevents traversal).

`/map` body is JSON `{ image?: dataURL, map: Array, dimensions: {width, height} }`
— the shape produced by `result.toAgentMap()` from snapdom's `agent-map`
plugin. When `image` is a `data:image/...;base64,…` URL, the handler
decodes it and writes the annotated PNG alongside the JSON.

`/diff` body is JSON `{ image: dataURL, diff: dataURL, stats: {...} }` —
the client runs pixel-diff in the browser via `@zumer/snapdiff/diff`
against the bytes returned by GET `/prev`, then POSTs the current image,
the diff image, and the stats together. The server rotates the existing
`X.png` to `X.prev.png` before writing the new one so the agent always
has the before/after pair on disk.

Any change to this contract is a breaking change. Add new endpoints
instead of altering these.

## Files and what they own

| File | Owns |
|------|------|
| `src/client.js` | snapDOM wrapper, error overlay, console mirror, `?snap=` / `?snapmap=` / `?snapdiff=` query triggers, `Shift+S` hotkey, optional `agentMap` + `diffCanvas` plugin paths, `namespace` query suffix, `window.snapeye` shape |
| `src/server.js` | Handler for `GET /prev` + `POST /snap, /dom, /map, /diff, /log`; filename + namespace sanitisation; absolute-path resolution; rotation of `X.png → X.prev.png` on diff; optional `onSnap`/`onMap`/`onDiff`/`onLog` hooks |
| `src/index.js` | Re-exports — nothing else |
| `examples/standalone/server.mjs` | Reference Node http integration; serves the repo root so importmap paths work |
| `examples/standalone/index.html` | Proof-of-life page that proves the round-trip works |

## Bugs we have already paid for

These cost time during development; future contributors should not pay
the same toll.

### 1. ASI bites: `[…].forEach(…)` after a statement

Original code:

```js
window.addEventListener('unhandledrejection', e => showErr(...))

['log','warn','error'].forEach(…)
```

Without a semicolon, JavaScript parses this as
`addEventListener(...)['log','warn','error'].forEach(...)` — a member
access on `undefined`. The whole script bombs at line 217, the snap
loop never starts, and you debug for an hour. Always prefix array
literals at statement position with `;`.

### 2. `el.click()` does not trigger Zumly

Zumly listens on `mouseup` / `touchend`, not on `click`. If you script
navigation in a host app by calling `trigger.click()`, the zoom
animation never fires. Use:

```js
trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
```

This isn't a SnapEye bug but it's the most common reason a consumer's
auto-snap loop hangs. Worth a note in adapter docs for Zumly-based apps.

### 3. `process.cwd()` in example duplicated paths

`createSnapEyeHandler({ dir: '.snapeye' })` resolves against
`process.cwd()`. If a consumer's example runs `node server.mjs` from
deep inside the repo and passes a deep relative path, the output dir
duplicates. The example now uses an absolute path computed from
`new URL('.', import.meta.url)`:

```js
const HERE = resolve(new URL('.', import.meta.url).pathname)
const snapEye = createSnapEyeHandler({ dir: resolve(HERE, '.snapeye') })
```

The handler itself respects absolute dirs — `resolve(cwd, abs)`
returns `abs` unchanged.

### 4. Browser tabs can stack `?snap=all` runs

When `open URL` is called from a script while another tab on the same
URL is already open, browsers may load a fresh tab without closing the
old one. Two tabs both ticking through the loop means two writes per
file and double the time. The driving script should close existing
tabs first (see zircleUI's example using `osascript`) or use a unique
port per session.

## Where this fits in the agent-visual loop

```
┌───────────────────┐                ┌──────────────────────────┐
│  Coding agent     │  Read PNG ←─── │  /your-project/.snapeye/ │
│  (Claude Code,    │                └──────────────────────────┘
│   Cursor, …)      │                            ▲
│                   │                            │ writeFile()
│  shell:           │                ┌──────────────────────────┐
│   open URL?snap=X │ ─── HTTP POST  │  createSnapEyeHandler    │
│   pkill server    │                │  (your dev server)       │
└───────────────────┘                └──────────────────────────┘
       │                                          ▲
       │ http open                                │ fetch
       ▼                                          │
┌───────────────────┐                ┌──────────────────────────┐
│  Browser tab      │ ─── snapDOM ──→│  attachSnapEye({snapdom})│
│  on localhost     │                └──────────────────────────┘
└───────────────────┘
```

The agent never opens DevTools and never sees the browser. It only
sees the disk and the terminal. SnapEye exists to make that survey
mode work.

## Things worth doing next (not done)

In rough order of value:

1. **Publish to npm.** `@zumer/snapeye@0.1.0`. peerDep on
   `@zumer/snapdom@^2.12`.
2. **Vite plugin.** `@zumer/snapeye-vite` — 20-line wrapper that calls
   `server.middlewares.use`. Probably belongs in its own tiny repo so
   the core stays dependency-free.
3. **GitHub Action.** `zumerlab/snapeye-action` — spins up
   `npm run dev`, opens a list of routes in Playwright, lets SnapEye
   capture each, uploads the PNGs as a PR comment. This is where the
   loop becomes useful in CI, not just local dev.
4. **Headless mode CLI.** `npx snapeye capture URL --routes a,b,c`.
   Wraps Playwright. Output goes through the same HTTP contract so
   `onSnap` hooks keep working.
5. **`@zumer/snapdiff` recipe** in this README — show how to combine
   the two: SnapEye writes `current/`, snapdiff compares against
   `baseline/`. Don't take the dependency, just document the pairing.
6. **Type definitions** as `.d.ts` files. Hand-rolled; the surface is
   tiny enough.

Each of these is a separate repo / release — keep the core (`/src/`)
unchanged when adding them.

## Smoke test

```sh
cd examples/standalone
node server.mjs &
open "http://localhost:8090/?snap=hello"
sleep 3
ls .snapeye/         # → hello.png  hello.html
```

If `hello.png` is not there after 3 s, check `/tmp/snapeye-real.log`
or whatever you redirected stdout to — the browser-side errors are
mirrored as `[browser] …` lines by the console forwarder.

## License & ownership

MIT · Juan Martín Muda · Zumerlab. Repo origin
`/Users/martin/GitHub/snapeye`. Future GitHub home (when published):
`github.com/zumerlab/snapeye`.
