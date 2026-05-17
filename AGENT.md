# SnapEye — contributor manual

You are an AI agent about to modify this repo. Read this before
touching anything. For everything user-facing (contract, install,
options, framework integration) **go to
[`README.md`](README.md)** — it is the source of truth and is also
written for AI agents. This file is the diff: what only matters when
you're changing the codebase.

## Origin

SnapEye was extracted from an ad-hoc pattern in a host project where
an AI agent needed to see the rendered UI: snapDOM in the page, a few
HTTP endpoints in the dev server, and a directory the agent could
`Read`. This package is that pattern pulled out into its own package —
**nothing else added**.

## What we explicitly decided NOT to do

These came up while building it. They are out of scope **on purpose**.
If you're about to add one, stop and check whether it belongs as a
recipe ([`RECIPES.md`](RECIPES.md)) or a sibling package instead.

- **No diff engine.** Pixel diff is `@zumer/snapdiff`. SnapEye captures.
- **No navigation logic.** The client exposes `snap(name, target?)`.
  The consumer decides when to call it.
- **No bundled framework wrappers.** The handler is
  `(req, res) => Promise<boolean>`. Vite/Express integration is
  3–5 lines in `README.md`.
- **No auth.** Endpoints are unauthenticated. Mount on localhost only.
- **No headless mode in the package.** A consumer can drive a headless
  browser themselves; the contract is HTTP.
- **No bundler.** Hand-written ESM. Adding a build step would cost more
  than it saves. Hand-rolled `.d.ts` can ship later if there's demand.

## The contract — DO NOT BREAK IT

See [`README.md` § Contract](README.md#contract) for the source of
truth. Two POST endpoints, sanitised `[a-z0-9._-]` names. Any change
to that table is a breaking change — add new endpoints instead of
altering existing ones. Experimental extensions live on the
[`agent-modes`](https://github.com/zumerlab/snapeye/tree/agent-modes)
branch and stay there until one earns adoption.

## Files and what they own

| File | Owns |
|------|------|
| `src/client.js` | snapDOM wrapper, error overlay, console mirror, `?snap=NAME` query trigger, `Shift+S` hotkey, `window.snapeye` shape |
| `src/server.js` | Two-endpoint handler (`/snap`, `/log`), filename sanitisation, absolute-path resolution, optional `onSnap`/`onLog` hooks |
| `src/index.js` | Re-exports — nothing else |
| [`RECIPES.md`](RECIPES.md) | Map of opt-in patterns (agent-map, snapdiff, namespace) parked on `agent-modes` |

## Bugs we have already paid for

These cost time during development. Future contributors should not pay
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

### 2. `process.cwd()` can surprise relative output dirs

`createSnapEyeHandler({ dir: '.snapeye' })` resolves against
`process.cwd()`. If a consumer runs a dev server from a different
directory than expected and passes a deep relative path, the output dir
can land somewhere surprising. Prefer absolute paths when integrating
inside custom servers:

```js
const HERE = resolve(new URL('.', import.meta.url).pathname)
const snapEye = createSnapEyeHandler({ dir: resolve(HERE, '.snapeye') })
```

The handler itself respects absolute dirs — `resolve(cwd, abs)`
returns `abs` unchanged.

### 3. Browser tabs can stack `?snap=all` runs

When `open URL` is called from a script while another tab on the same
URL is already open, browsers may load a fresh tab without closing the
old one. Two tabs both ticking through the loop means two writes per
file and double the time. The driving script should close existing
tabs first (e.g. via `osascript`) or use a unique port per session.

## Roadmap

Rough order of value, kept here so a contributing agent can pick the
right next thing:

1. **Done — `@zumer/snapeye@0.1.0` on npm** (peerDep `@zumer/snapdom@^2.12`).
2. **`zumerlab/snapeye-action`.** GitHub Action that spins up
   `npm run dev`, drives Playwright across a list of routes, lets
   SnapEye capture each, uploads PNGs as a PR comment. This is where
   the loop pays off in CI, not just local dev.
3. **Headless CLI.** `npx snapeye capture URL --routes a,b,c`. Wraps
   Playwright; output goes through the same HTTP contract so `onSnap`
   hooks keep working.
4. **Promote `agent-modes` to companion packages** once one of the
   three recipes (agent-map / snapdiff / namespace) has a real user
   pulling on it.
5. **Hand-rolled `.d.ts`.** Surface is small enough.

Each is a separate repo / release. **Keep `/src/` unchanged when
adding any of them.**

## License

MIT · Juan Martín Muda · Zumerlab. Source:
`github.com/zumerlab/snapeye`.
