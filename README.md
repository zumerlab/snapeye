# SnapEye

SnapEye gives an AI coding agent eyes on a running web app.

It is a tiny localhost bridge:

1. The browser captures DOM with `@zumer/snapdom`.
2. The browser POSTs a PNG to the dev server.
3. The server writes `.snapeye/<name>.png`.
4. The agent reads that PNG and keeps editing.

No bundled browser automation. No baseline diffing. No framework runtime.
Just a client helper and a two-endpoint Node HTTP handler.

For an agent, this is not a full visual testing stack; it is the cheap
feedback loop that catches the common "I changed UI but cannot see it"
case while leaving navigation, clicks, auth, and pixel-perfect testing to
the host project.

## Agent Contract

You are an AI coding agent in a repo with SnapEye wired into the dev app.
Your job is to trigger captures, read the PNGs, and use what you see to
iterate on UI work.

The server owns two POST endpoints under `/__snapeye__`:

| Method | Path                       | Body         | Side effect                     |
| ------ | -------------------------- | ------------ | ------------------------------- |
| POST   | `/__snapeye__/snap?name=X` | `image/png`  | Writes `<dir>/X.png`            |
| POST   | `/__snapeye__/log`         | `text/plain` | Prints stdout as `[browser] ...` |

`name` is sanitized to `[a-z0-9._-]`; invalid characters become `_`.
Missing names become `snap-<timestamp>`. `<dir>` defaults to `.snapeye`
unless the server config overrides it.

This is the stable contract. Anything that produces these POSTs is a
valid client.

## Fast Path

If SnapEye is already installed in the repo:

```sh
open "http://localhost:8080/?snap=home"
```

Then read:

```text
.snapeye/home.png
```

If the PNG does not appear, inspect the dev server stdout. Browser
console output should be mirrored as `[browser] ...` lines when
`forwardConsole` is enabled.

## Install

```sh
npm install --save-dev @zumer/snapeye @zumer/snapdom
```

`@zumer/snapdom` is a required peer dependency.

## Browser Setup

Add this somewhere in the app's client bundle:

```js
import { snapdom } from '@zumer/snapdom'
import { attachSnapEye } from '@zumer/snapeye/client'

attachSnapEye({ snapdom })
```

This attaches:

```js
window.snapeye.snap(name, target?)
window.snapeye.log(level, ...args)
window.snapeye.options
```

## Server Setup

Mount the handler before the app's own routing:

```js
import { createServer } from 'node:http'
import { createSnapEyeHandler } from '@zumer/snapeye/server'

const snapEye = createSnapEyeHandler({ dir: '.snapeye' })

createServer(async (req, res) => {
  if (await snapEye(req, res)) return
  // host app routing goes here
}).listen(8080)
```

The handler signature is:

```ts
(req: import('node:http').IncomingMessage,
 res: import('node:http').ServerResponse) => Promise<boolean>
```

It returns `true` when it handled the request.

## Trigger Captures

Use whichever path is available in the environment.

```sh
# URL trigger, useful for agents
open "http://localhost:8080/?snap=home"
```

```js
// Programmatic capture
await window.snapeye.snap('hero')
await window.snapeye.snap('checkout', document.querySelector('.checkout'))
```

```text
Shift + S captures the default target.
```

After capture, read `.snapeye/<name>.png`.

## Client Options

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

## Server Options

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

Do not pass Fetch `Request`/`Response` objects directly to this handler.
It expects Node `IncomingMessage` and `ServerResponse`. Fetch-native
runtimes need a small adapter or a separate handler implementation.

## Agent Loop

Use this loop when editing UI:

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
- Confirm the app loaded the client setup.
- Confirm server `prefix` matches client `endpoint`.
- Confirm the output directory is the one you are reading.

SnapEye intentionally does not navigate your app. For multi-route
captures, drive routing yourself and call `window.snapeye.snap(name)`
after each route has rendered.

## What It Does Not Do

- No visual regression baseline. Use `@zumer/snapdiff` or a recipe.
- No bundled headless mode. Drive Playwright/Puppeteer yourself if needed.
- No authentication. Mount on localhost/dev servers only.
- No Fetch-native server adapter in core.
- No TypeScript declarations yet.

## Recipes

The core stays small. Optional patterns live in `RECIPES.md`:

- `agent-map`: annotated Set-of-Mark PNG plus element metadata JSON.
- `snapdiff`: compare the current capture with the previous one.
- `namespace`: isolate multiple agents writing to the same server.

## License

[MIT](LICENSE) - (c) [Zumerlab](https://github.com/zumerlab)

## For Humans

SnapEye is useful if you want an agent to verify real rendered UI without asking you to describe the screen: wire the client into your dev page, mount the server handler on localhost, open a route with `?snap=name`, and the agent gets a PNG it can inspect; if you need pixel-perfect browser screenshots, visual regression history, auth, or navigation orchestration, use Playwright or a dedicated visual-testing tool alongside SnapEye rather than expanding the core.
