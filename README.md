# SnapEye

**Gives an AI coding agent eyes on a running web app.**

One `?snap=name` URL → PNG on disk → the agent reads it and keeps editing.
No bundled browser automation, no baseline diffing, no framework runtime.
A snapDOM client + a two-endpoint HTTP handler — that's it.

[Quickstart](#quickstart) ·
[AGENTS.md snippet](#add-to-your-agentsmd) ·
[Setup](#setup) ·
[Triggers](#trigger-captures) ·
[Options](#options) ·
[Frameworks](#framework-integration) ·
[Contract](#the-contract) ·
[Recipes](#recipes)

## Quickstart

If SnapEye is already wired into the project, an agent only needs this:

```sh
open "http://localhost:8080/?snap=home"
# then read .snapeye/home.png
```

To wire it into a new project, three small pieces:

```sh
npm install --save-dev @zumer/snapeye @zumer/snapdom
```

```js
// client — somewhere in the app bundle
import { snapdom } from '@zumer/snapdom'
import { attachSnapEye } from '@zumer/snapeye/client'
attachSnapEye({ snapdom })
```

```js
// server — before the host app's routing
import { createSnapEyeHandler } from '@zumer/snapeye/server'
const snapEye = createSnapEyeHandler({ dir: '.snapeye' })
// in your request handler:  if (await snapEye(req, res)) return
```

Capture from any of: URL (`?snap=name`), JS (`window.snapeye.snap('name')`),
or hotkey (`Shift + S`).

## Add to your AGENTS.md

So your agent knows SnapEye exists and how to use it, append the snippet
below to your project's `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, or
equivalent. Adjust the URL/port to your dev setup.

````markdown
## UI Verification with SnapEye

This project has SnapEye wired into the dev server. Use it to *see* the
rendered UI instead of inferring it from the DOM or CSS.

### Capture a screen

```sh
open "http://localhost:8080/?snap=home"
```

This writes `.snapeye/home.png`. Read it with your image-reading tool.

### Capture programmatically

```js
await window.snapeye.snap('hero')
await window.snapeye.snap('checkout', document.querySelector('.checkout'))
```

### Loop

1. Make the UI change.
2. Trigger a capture (`?snap=<name>` or `snap()` call).
3. Read `.snapeye/<name>.png`.
4. If the PNG is missing or stale, check dev server stdout for
   `[browser] ...` lines.

Names are sanitized to `[a-z0-9._-]`. Output dir defaults to `.snapeye/`.
````

## Setup

### Install

```sh
npm install --save-dev @zumer/snapeye @zumer/snapdom
```

`@zumer/snapdom` is a required peer dependency.

### Browser

```js
import { snapdom } from '@zumer/snapdom'
import { attachSnapEye } from '@zumer/snapeye/client'

attachSnapEye({ snapdom })
```

Attaches:

```js
window.snapeye.snap(name, target?)
window.snapeye.log(level, ...args)
window.snapeye.options
```

### Server

```js
import { createServer } from 'node:http'
import { createSnapEyeHandler } from '@zumer/snapeye/server'

const snapEye = createSnapEyeHandler({ dir: '.snapeye' })

createServer(async (req, res) => {
  if (await snapEye(req, res)) return
  // host app routing
}).listen(8080)
```

Handler signature:

```ts
(req: import('node:http').IncomingMessage,
 res: import('node:http').ServerResponse) => Promise<boolean>
```

Returns `true` when it handled the request.

## Trigger Captures

```sh
# URL — best for agents
open "http://localhost:8080/?snap=home"
```

```js
// Programmatic
await window.snapeye.snap('hero')
await window.snapeye.snap('checkout', document.querySelector('.checkout'))
```

```text
Shift + S captures the default target.
```

After capture, read `.snapeye/<name>.png`.

## Options

### Client

```js
attachSnapEye({
  snapdom,                         // required
  endpoint: '/__snapeye__',        // must match server prefix
  autoOnQuery: true,               // ?snap=foo captures after load
  forwardConsole: true,            // mirrors console.* to /log
  errorOverlay: true,              // top bar for errors/rejections
  defaultTarget: () => document.documentElement,
  hideSelectors: ['.dev-only'],    // temporarily hidden during capture
  snapdomOptions: { dpr: 1, scale: 1 },
  hotkey: 'S'                      // Shift + S; set null to disable
})
```

### Server

```js
createSnapEyeHandler({
  dir: '.snapeye',
  prefix: '/__snapeye__',
  log: (line) => console.log(line), // pass null to silence
  onSnap: ({ name, path, bytes }) => {},
  onLog: ({ line }) => {}
})
```

## Framework Integration

### Vite

```js
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

### Express / Connect

```js
const snapEye = createSnapEyeHandler({ dir: '.snapeye' })

app.use(async (req, res, next) => {
  if (!(await snapEye(req, res))) next()
})
```

Do not pass Fetch `Request`/`Response` directly — the handler expects
Node `IncomingMessage` / `ServerResponse`. Fetch-native runtimes need a
small adapter.

## The Contract

Two POST endpoints under `/__snapeye__`:

| Method | Path                       | Body         | Side effect                       |
| ------ | -------------------------- | ------------ | --------------------------------- |
| POST   | `/__snapeye__/snap?name=X` | `image/png`  | Writes `<dir>/X.png`              |
| POST   | `/__snapeye__/log`         | `text/plain` | Prints stdout as `[browser] ...`  |

`name` is sanitized to `[a-z0-9._-]`; invalid characters become `_`.
Missing names become `snap-<timestamp>`. `<dir>` defaults to `.snapeye`.

This is the stable contract. Anything that produces these POSTs is a
valid client.

## Agent Loop

```bash
# 1. Start fresh
rm -rf .snapeye
npm run dev > /tmp/dev.log 2>&1 &

# 2. Trigger the route
open "http://localhost:8080/?snap=home"

# 3. Read the result
# .snapeye/home.png
```

If the capture is stale or missing:

- Check `/tmp/dev.log` for `[browser] ...` output.
- Confirm the client is loaded.
- Confirm the server `prefix` matches the client `endpoint`.
- Confirm the output directory is the one you're reading.

SnapEye intentionally does not navigate your app. For multi-route
captures, drive routing yourself and call `window.snapeye.snap(name)`
after each route has rendered.

## What It Does Not Do

- No visual regression baseline — see `@zumer/snapdiff` or a recipe.
- No bundled headless mode — drive Playwright/Puppeteer yourself.
- No auth — mount on localhost / dev servers only.
- No Fetch-native server adapter in core.
- No MCP server (may ship as a sibling package, not in core).
- No TypeScript declarations yet.

## Recipes

The core stays small. Optional patterns live in [`RECIPES.md`](RECIPES.md):

- `agent-map` — annotated Set-of-Mark PNG + element metadata JSON.
- `snapdiff` — compare the current capture with the previous one.
- `namespace` — isolate multiple agents writing to the same server.

## License

[MIT](LICENSE) — © [Zumerlab](https://github.com/zumerlab)

## For Humans

SnapEye is useful if you want an agent to verify real rendered UI
without asking you to describe the screen: wire the client into your
dev page, mount the server handler on localhost, open a route with
`?snap=name`, and the agent gets a PNG it can inspect. If you need
pixel-perfect screenshots, regression history, auth, or navigation
orchestration, use Playwright or a dedicated visual-testing tool
alongside SnapEye rather than expanding the core.
