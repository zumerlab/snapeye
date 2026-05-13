# 👁 SnapEye

> **A 50-line bridge that lets a coding agent _see_ your running web app.**
> Two files. snapDOM in the browser, a tiny HTTP handler on the server,
> PNG and DOM dumps written to disk where any agent can read them.

No headless browser. No Playwright. No baselines. No framework.
Just a contract.

---

## Why

Coding agents (Claude Code, Cursor, Aider, Copilot Workspace, OpenDevin…)
can read files but not look at a browser. The result: a category of bugs
they're blind to — layout drift, broken theming, components rendered at
0×0 because of a CSS regression. They write code, you re-load, they ask
you what they see.

SnapEye closes that loop. The agent runs an `npm run dev`, opens a URL,
the page captures itself with [`@zumer/snapdom`](https://github.com/zumerlab/snapdom)
and POSTs the result back to the dev server, which drops a `.png` next to
the agent's filesystem. The agent reads the PNG, sees what's wrong, edits,
iterates.

It is **not** a visual-regression tool (use
[`@zumer/snapdiff`](https://github.com/zumerlab/snapdiff) for that, on top
of SnapEye), and it is **not** a screenshot service (use Playwright if
you need fidelity). It is the **smallest possible bridge** that gives an
agent eyes.

---

## Install

```sh
npm install --save-dev @zumer/snapeye @zumer/snapdom
```

`@zumer/snapdom` is a peer dependency. Bring your own copy.

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
`.snapeye/home.png`. Or, from inside the app:

```js
window.snapeye.snap('hero')
window.snapeye.snap('checkout-step-2', document.querySelector('.checkout'))
```

Or press <kbd>Shift+S</kbd>.

---

## What the agent gets

Each call produces:

| File                  | Content                                          |
|-----------------------|--------------------------------------------------|
| `<dir>/<name>.png`    | Raster capture of the target element             |
| `<dir>/<name>.html`   | The element's `outerHTML` at capture time        |
| Terminal              | `console.log/.warn/.error` mirrored as `[browser] …` |

The agent can open the PNG with its multimodal `Read` tool, the HTML to
inspect computed structure, and the terminal log to catch runtime errors
without DevTools.

---

## The contract

Three POST endpoints under a configurable prefix (default `/__snapeye__`).
Anyone can implement the server side in 30 lines of any language; the
included `createSnapEyeHandler` is the Node reference implementation.

| Endpoint                          | Body          | Side effect                                |
|-----------------------------------|---------------|--------------------------------------------|
| `POST /__snapeye__/snap?name=X`   | `image/png`   | Write `<dir>/X.png`                        |
| `POST /__snapeye__/dom?name=X`    | `text/html`   | Write `<dir>/X.html`                       |
| `POST /__snapeye__/log`           | `text/plain`  | Echo to server stdout as `[browser] …`     |

Filenames are sanitized to `[a-z0-9._-]`. Unknown names fall back to
`snap-<timestamp>`.

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
  endpoint: '/__snapeye__',        // must match server prefix
  autoOnQuery: true,               // ?snap=foo triggers eye.snap('foo')
  forwardConsole: true,            // mirror console.* to /log
  errorOverlay: true,              // top-bar overlay for window.onerror
  defaultTarget: () => document.documentElement,
  hideSelectors: ['.dev-only'],    // hidden during the capture
  snapdomOptions: { dpr: 1, scale: 1 },
  hotkey: 'S'                      // null to disable; Shift + key
})
```

Returns `{ snap(name, target?), log(level, …args), options }`. Also
attached as `window.snapeye`.

---

## Server options

```js
createSnapEyeHandler({
  dir: '.snapeye',                 // output directory (relative to cwd)
  prefix: '/__snapeye__',
  log: (line) => console.log(line),// pass null to silence
  onSnap: ({ name, path, bytes }) => {},
  onLog:  ({ line }) => {}
})
```

---

## Iterating from an agent

A typical loop for a coding agent driving the project:

```bash
# 1. Restart dev server
pkill -f "your-dev-server" || true
rm -rf .snapeye
npm run dev > /tmp/dev.log 2>&1 &

# 2. Trigger a capture (and any in-page navigation)
open "http://localhost:8080/?snap=home"

# 3. Wait, then read the result
sleep 2
# (the agent does: Read .snapeye/home.png)
```

For multi-route capture, drive the navigation yourself inside the app
(`router.push(route)` → `window.snapeye.snap(route.name)` →
`afterRender` →  next). SnapEye intentionally does **not** know how
your app navigates.

---

## What it does not do

- **No baseline diffing.** Pair with `@zumer/snapdiff` if you want that.
- **No headless mode.** A tab needs to be open. For CI, drive a headless
  browser yourself (Playwright/Puppeteer) — they speak the same HTTP
  contract.
- **No auth.** The endpoints are unauthenticated. Mount them only on
  your local dev server.

---

## License

[MIT](LICENSE) · © Juan Martín Muda · [Zumerlab](https://github.com/zumerlab)
