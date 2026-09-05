# SnapEye

**Capture. Compare. Record. Visual tools for coding agents.**

SnapEye is a small, deterministic visual toolbelt built on
[SnapDOM](https://github.com/zumerlab/snapdom). A coding agent runs one command,
gets a JSON answer, and only opens an image when the JSON says it should:

```sh
$ npx snapeye diff dashboard --target '#dashboard'
{ "status": "ok", "diff": { "changed": false, "changedRatio": 0, ... } }
```

SnapEye does not navigate, click, reason, call a model, or orchestrate an agent.

## Install

```sh
npm install --save-dev @zumer/snapeye @zumer/snapdom@latest
```

SnapEye supports SnapDOM `^2.24.10 || ^3.0.0-0`, including v3 prereleases.
The development dependency stays on the published v2 release. To verify a local
compiled v3 build without replacing it:

```sh
SNAPDOM_TEST_PATH=../snapdom-v3/dist/snapdom.mjs SNAPDOM_EXPECTED_MAJOR=3 npm run test:browser
```

Capture and diff invalidate SnapDOM's style caches by default so CSSOM-only
changes are captured. Set `snapdomOptions.invalidate: false` only to deliberately
test memoization. SnapEye ignores reusable `snapdomOptions.canvas` targets so
recording frames retain independent pixels. Recheck existing v2 baselines when
upgrading the renderer; approve replacements only after inspecting the changes.

### Any Vite app

```js
import { defineConfig } from 'vite'
import { snapeye } from '@zumer/snapeye/vite'

export default defineConfig({
  plugins: [snapeye()]
})
```

That is the whole setup, including for frameworks that render their own HTML.
Vite's `transformIndexHtml` hook only fires for pages Vite itself serves, so
Astro, Nuxt, SvelteKit, Remix and Qwik would never receive the client — and the
failure is silent: `/__snapeye/health` answers `ok` while `window.snapeye` never
exists and every operation burns its timeout. Rather than ship an adapter per
framework, the plugin injects the client into any HTML the dev server sends.
Verified on a real Astro + Starlight site.

Those frameworks own the Vite config, so the plugin goes where they keep it:

```js
// astro.config.mjs · nuxt.config.ts · svelte.config.js …
export default defineConfig({
  vite: { plugins: [snapeye()] }
})
```

If a host ever does not receive the client, check it directly — this is the one
setup failure worth ruling out first:

```sh
curl -s -H 'Accept: text/html' localhost:5173 | grep -c data-snapeye-client   # expect 1
```

Configuration is intentionally small:

```js
snapeye({
  root: '.snapeye', // relative to Vite's project root
  maxRuns: 20,
  client: {
    forwardConsole: false, // mirror the page console to the Vite terminal
    errorOverlay: false,   // in-page overlay for uncaught errors
    hotkey: false,         // Shift + <key> captures a baseline
    hotkeyName: 'current'  // baseline that hotkey capture replaces
  }
})
```

The `client` options are the injected runtime's only in-page side effects, and
all of them are off by default: SnapEye does not patch `console`, does not draw
over the page, and does not take a key away from the application unless asked.
Unknown or malformed options throw instead of being ignored.

Enabling `hotkey` makes Shift + that key run a real `capture()`, replacing the
`hotkeyName` baseline. It is deliberately inert while typing into an input,
textarea, select, or contenteditable element, and while any other modifier is
held.

## Use it in a real task

SnapEye does not start Codex, Claude Code, Cursor, or another coding agent. Start
the agent as usual, give it the repository and a running dev server, and ask it
to use SnapEye as part of the task.

For example, suppose the header needs an internal refactor but must look exactly
the same. Start the app:

```sh
npm run dev
```

Then paste a task like this into the coding agent:

```text
Refactor the site header to remove the duplicated CSS. Its appearance must not
change.

Verify with SnapEye:
1. Before editing, run:
   npx snapeye capture header-desktop --target '#site-header'
2. Make the code change.
3. Then run:
   npx snapeye diff header-desktop --target '#site-header' --fail-on-change
4. Read the JSON it prints before opening any image.
5. If it reports a change, use diff.regions to find it, fix the regression, and
   diff again until it exits 0.
6. Report the final verdict and the run IDs.

Do not replace the baseline after the edit just to make the diff pass.
```

Each command prints the terminal result and exits with a code the agent can
branch on:

```sh
$ npx snapeye diff header-desktop --target '#site-header' --fail-on-change
{
  "status": "ok",
  "operation": "diff",
  "diff": { "changed": false, "changedRatio": 0, "regionCount": 0, "regions": [] },
  ...
}
$ echo $?
0
```

For a refactor with no intended visual effect, `diff.changed: false` is the
passing result. For an intentional redesign, `diff.changed: true` is expected:
use the reported regions plus `current.png` and `diff.png` to confirm only the
intended area changed, then replace the approved baseline with a new `capture`.

For animations and transitions, use `record` and read the bounded `frames.png`
contact sheet first; open the GIF or video only if the timing needs a closer
look. More copy-paste scenarios are in [RECIPES.md](RECIPES.md).

## Agent workflow

There are three ways in, and they answer the same question with the same
`result.json`. Pick by what the agent can do and by which state it needs.

### 1. One command — the default

```sh
npx snapeye diff dashboard --target '#dashboard'
```

The CLI checks health, mints a run ID, opens the trigger URL, waits for the
terminal result, prints it to stdout, and exits with a code that already answers
the question. No polling loop to write.

The health check is bounded to 5 seconds (or `--timeout`, if shorter). An
existing run directory is rejected before opening the page, and the terminal
result must match the requested run, operation, and baseline. Use a fresh run
ID for every invocation, including concurrent commands.

```
0  status "ok"        2  environment problem (no dev server, no plugin, timed out)
1  status "error"     3  --fail-on-change and the diff reported a change
```

Only the result JSON goes to stdout, so `npx snapeye diff dashboard | jq
'.diff.changed'` works. Progress and diagnostics go to stderr.

```sh
npx snapeye capture header-desktop --target '#site-header'
npx snapeye diff   header-desktop --target '#site-header' --fail-on-change
npx snapeye record menu --target '.menu' --duration 3000 --fps 10 --format gif
npx snapeye diff dashboard --url http://localhost:5173/settings?tab=billing
npx snapeye --help
```

Use `--no-open` when the agent drives its own browser: the CLI prints the URL,
the agent navigates to it, and the CLI still does the waiting.

### 2. From the page — for states behind an interaction

The URL trigger reloads the page, so it can only reach states a fresh load
produces. Anything behind a click, a filled form, an open modal, or a login is
reached by driving the page and then calling the API directly. The promise
resolves with the whole result **inline** — no run ID, no polling, no file to
read:

```js
await page.click('#open-settings')
const result = await page.evaluate(() => window.snapeye.diff('settings-modal', '#modal'))
if (result.diff.changed) { /* inspect result.diff.regions */ }
```

`result.json` is still written for the record. This is the shortest path for any
agent that can evaluate JavaScript in the page.

### 3. The raw URL protocol

Both of the above are built on this, and it is what to use when all the agent
can do is open a URL:

```text
http://localhost:5173/?__snapeye=capture&name=dashboard&run=agent_001
http://localhost:5173/?__snapeye=diff&name=dashboard&run=agent_002
http://localhost:5173/?__snapeye=record&name=menu&run=agent_003&duration=3000&fps=10
```

Then wait for `.snapeye/runs/<runId>/result.json`. Never reuse a run ID; there
is no global result file.

### Reading a diff

`status` is always read first. After that:

| Result | Meaning | What to do |
| --- | --- | --- |
| `status: "error"` | The run never compared anything | Read `error.code`; do not open any image |
| `changed: false` | Nothing moved | Done. Do not open any image |
| `changed: true`, every region under ~8 CSS px on both sides | Text rendering or a sub-pixel shift | Open `diff.png` before changing code |
| `changed: true` with a region larger than that | A real visual change | Compare it against what the task intended |
| `regionsTruncated: true` | More regions than the limit; `regions` holds one aggregate box | Treat as a large change and open `diff.png` |

`changedRatio` is the fraction of compared pixels that changed, from 0 to 1. It
is a magnitude, not a verdict: a ratio of 0.002 concentrated in one 200×40
region is a broken button, and the same ratio spread over 30 tiny regions is
usually text rendering.

### Paste-ready agent instructions

Copy this into `AGENTS.md`, `CLAUDE.md`, or the equivalent:

````markdown
## Visual verification with SnapEye

Use `npx snapeye` to verify anything visual. It prints `result.json` to stdout.

```sh
npx snapeye capture <name> --target '<css-selector>'   # record the reference
npx snapeye diff    <name> --target '<css-selector>'   # compare against it
npx snapeye record  <name> --target '<css-selector>' --duration 3000
```

Exit codes: 0 = ok, 1 = the run failed (read `error.code`), 2 = SnapEye or the
dev server is not running, 3 = `--fail-on-change` and the diff changed.

Rules:

1. Read `status` before anything else.
2. On `diff.changed: false`, you are done. Do not open any image.
3. On `diff.changed: true`, use `diff.regions` to decide whether to open
   `diff.png`. Regions are CSS pixels from the top-left of the captured target.
4. Capture the baseline BEFORE editing, and never re-capture it afterwards just
   to make a diff pass.
5. Use a fresh name per component/viewport; baselines are committed.
6. For a state behind an interaction, drive the page and call
   `window.snapeye.diff(name, selector)` — it returns the result inline.
7. On exit code 2, report that the SnapEye environment is not running. Do not
   silently continue without visual verification.
````

The health check answers before the browser client initializes, so an agent can
tell "not installed" from "still working":

```sh
curl http://localhost:5173/__snapeye/health
```

```json
{
  "status": "ok",
  "name": "@zumer/snapeye",
  "version": "<package-version>",
  "protocolVersion": 1,
  "artifactRoot": ".snapeye",
  "artifactRootResolved": "/repo/.snapeye"
}
```

## Operations

Every URL-triggered operation requires:

- `__snapeye`: `capture`, `diff`, or `record`;
- `name`: a baseline name;
- `run`: a unique run ID supplied by the caller.

Run IDs accept 1–64 ASCII letters, digits, `_`, and `-`. Names accept those
characters plus `.` and must start with a letter or digit. Invalid values are
rejected rather than silently rewritten. An optional `target` query parameter
may contain a CSS selector; otherwise SnapEye captures its configured default,
then falls back to `document.documentElement`.

Three optional parameters control timing: `wait` holds the operation for a
number of milliseconds or until a CSS selector matches, `stabilize=0` turns off
motion pinning, and `settle=0` turns off waiting for the page to go quiet (both
below).

### Determinism

A spinner, a pulsing dot, a skeleton loader, or a transition still in flight all
look different depending on when the capture happens. Left alone, that produces
diffs nobody caused: on a page with one CSS spinner, an unstabilized SnapEye
reported a change in **7 of 8 identical runs**.

So before every `capture` and `diff` — never for `record`, whose subject is
motion — SnapEye pins the page:

- endless animations are rewound to their first frame and paused, so every run
  captures the same frame rather than whichever one the clock landed on;
- finite animations and in-flight transitions are fast-forwarded to the state
  they were heading to, which is the settled appearance;
- a stylesheet stops anything that tries to start during the capture.

Everything is restored afterwards. With this in place the same page reports
**0 false positives in 12 runs** at randomized phases, while a real change is
still detected.

Running animations resume after capture. Stability waits also have a timer
fallback when a background tab stops receiving animation frames.

What it does not pin is anything JavaScript draws frame by frame — a `<canvas>`
render loop, a WebGL scene, a chart animating through `requestAnimationFrame`.
For those, capture at a known point with `--wait`, or expose a class the app
sets when it settles and wait for that selector:

```sh
npx snapeye diff chart --target '#chart' --wait '#chart.is-rendered'
npx snapeye diff chart --target '#chart' --wait 500
npx snapeye diff hero  --target '#hero'  --no-stabilize   # opt out entirely
```

Baselines captured before this behavior existed were taken at an arbitrary
animation frame. Re-capture any baseline whose target animates.

### Settling

Every operation also waits for the page to stop changing before capturing,
bounded to 2.5 s. This exists because of the other way a page lies about itself:
the **first** request to a cold dev server spends seconds compiling modules and
hydrating components, while every later request is warm and settles in
milliseconds. Capture a baseline on that first request and diff against warm
ones and you get a constant, entirely fake change — measured at 9 false
positives out of 12 on a real Astro site, and 0 with settling on.

The signature is geometry only (document size, image and stylesheet count, and
the target's own box), so a page animating colours or canvas pixels reads as
settled immediately and costs three frames. Turn it off with `settle: false`
(`&settle=0` on the URL) and raise or lower the ceiling with `settleTimeout`.

Geometry is not everything: content that keeps repainting inside a stable box —
a `<canvas>` loop, a WebGL scene — still needs `--wait`.

### Capture

```text
?__snapeye=capture&name=dashboard&run=abc123
```

Capture writes or explicitly replaces:

```text
.snapeye/baselines/dashboard.png
.snapeye/baselines/dashboard.json
.snapeye/runs/abc123/result.json
```

Baseline metadata records the target descriptor, CSS dimensions, raster
dimensions, effective raster scale, and schema version. Baselines are not
ignored by Git and are meant to be committed when desired.

### Diff

```text
?__snapeye=diff&name=dashboard&run=abc124
```

Diff reads the named baseline, captures the current target once, compares it
with SnapDiff, and writes:

```text
.snapeye/runs/abc124/current.png
.snapeye/runs/abc124/diff.png
.snapeye/runs/abc124/result.json
```

Read `result.json` first. Its compact `diff` block answers whether anything
changed, the changed-pixel ratio, and where meaningful change regions are. A
missing or dimensionally incompatible baseline produces a terminal error
instead of misleading metrics.

### Record

```text
?__snapeye=record&name=menu&run=abc125&duration=3000&fps=10&format=both
```

Record captures one target for a fixed duration. A single shared frame sequence
feeds the GIF adapter, browser-native video adapter, filmstrip, timestamps, and
metrics. It does not coordinate clicks and cannot cross a navigation.

Options:

| Option | Default | Enforced range |
| --- | ---: | ---: |
| `duration` | `3000` ms | 100–15,000 ms |
| `fps` | `10` | 1–30 |
| `format` | `gif` | `gif`, `video`, `both` |
| `scale` | `1` | 0.1–2 |

At most 150 frames and 120 million total raster pixels are retained. SnapEye
reduces scale and then frame count when needed; a target that cannot fit even
one minimum-scale frame fails explicitly. Video uses the best `MediaRecorder`
container offered by the browser, so the artifact may be `recording.webm` or
`recording.mp4`.

Recording owns its raster budget: it forces `dpr: 1`, disables root-shadow
expansion and SnapDOM burst caching, and ignores `snapdomOptions.width` and
`height`. Use the bounded top-level `scale` option to size recording frames.

The bounded `frames.png` contact sheet contains temporally distributed key
frames. `result.json` maps every filmstrip cell to its source frame and real
timestamp.

## JavaScript API

The injected client exposes:

```js
await window.snapeye.capture('dashboard', '#dashboard', { runId: 'abc123' })
await window.snapeye.diff('dashboard', document.querySelector('#dashboard'), {
  runId: 'abc124'
})
await window.snapeye.record('menu', '.menu', {
  runId: 'abc125',
  duration: 3000,
  fps: 10,
  format: 'both',
  scale: 1
})
```

Every operation also accepts `waitFor` (milliseconds or a selector),
`stabilize: false`, and `waitTimeout`:

```js
await window.snapeye.diff('chart', '#chart', { waitFor: '#chart.is-rendered' })
await window.snapeye.capture('hero', '#hero', { stabilize: false })
```

The target selector is resolved after `waitFor` completes, so it can refer to
an element that hydration creates or replaces while SnapEye is waiting.

`runId` is optional only in the JavaScript API. SnapEye generates one and
returns it in the resolved terminal result. The promise resolves only after all
artifacts and the atomic terminal result have been persisted. For compatibility,
`window.snapeye.snap()` is an alias of `capture()` and `?snap=name` remains a
capture shorthand with an automatically generated run ID.

Manual browser integrations can still use `attachSnapEye()`:

```js
import { snapdom } from '@zumer/snapdom'
import { attachSnapEye, createHttpArtifactStore } from '@zumer/snapeye/client'

const store = createHttpArtifactStore({ endpoint: '/__snapeye', token })
attachSnapEye({ snapdom, store })
```

The Vite plugin supplies its ephemeral token automatically; application code
must not need or expose it.

### Opt-in redaction with SnapDOM v3

SnapEye does not add automatic redaction. With v3 and its matching official
plugins installed, pass the same policy to capture, diff, and record through the
JavaScript API:

```js
import { redactInputs } from '@zumer/snapdom-plugins/redact-inputs'

const privateCapture = {
  snapdomOptions: {
    plugins: [redactInputs({
      blocks: '.private-panel',
      attributes: [{ selector: '[data-token]', names: ['data-token', 'title'] }]
    })]
  }
}
await window.snapeye.capture('panel', '#panel', privateCapture)
await window.snapeye.diff('panel', '#panel', privateCapture)
await window.snapeye.record('panel', '#panel', { ...privateCapture, duration: 800, fps: 5 })
```

`blocks` hides visible subtrees and keeps their space by default. Attribute rules
remove the named metadata; copies already painted as text, CSS content, or
bitmaps require blocking that content. Use the same policy for the baseline and
later comparisons. These plugin objects belong in browser JavaScript, not the
Vite plugin's JSON client configuration or CLI flags.

Run the optional composition regression against the matching local plugins:

```sh
SNAPDOM_TEST_PATH=../snapdom-v3/dist/snapdom.mjs SNAPDOM_EXPECTED_MAJOR=3 \
SNAPDOM_PLUGINS_TEST_PATH=../snapdom-v3/packages/plugins npm run test:browser
```

## Result contract

An agent must inspect `status` before any operation-specific field:

```json
{
  "schemaVersion": 1,
  "protocolVersion": 1,
  "runId": "abc124",
  "status": "ok",
  "operation": "diff",
  "name": "dashboard",
  "target": { "selector": "#dashboard" },
  "image": {
    "coordinateSpace": "target-css-px",
    "cssWidth": 600,
    "cssHeight": 400,
    "pixelWidth": 1200,
    "pixelHeight": 800,
    "scale": 2
  },
  "diff": {
    "changed": true,
    "changedRatio": 0.031,
    "regionCount": 1,
    "regionsTruncated": false,
    "regions": [
      { "x": 420, "y": 85, "width": 180, "height": 42, "aggregate": false }
    ]
  },
  "artifacts": {
    "baseline": "../../baselines/dashboard.png",
    "current": "current.png",
    "diff": "diff.png"
  }
}
```

All region coordinates are CSS pixels from the top-left of the axis-aligned
capture viewport SnapDOM produced for the target. For a normal untransformed
target this is its top-left edge; root transforms or render bleed can expand
that viewport around the logical element. Convert viewport coordinates to PNG
pixels with `filePx = cssPx * image.scale`.
`changedRatio` is the fraction of compared raster pixels considered changed,
always from 0 to 1. Tiny and nearby changes are filtered/grouped. If the true
region count exceeds the result limit, `regionsTruncated` is `true` and
`regions` contains one aggregate bounding box while `regionCount` preserves the
true count.

Recording metadata reports requested and actual values:

```json
{
  "record": {
    "durationRequestedMs": 3000,
    "durationActualMs": 3042,
    "fpsRequested": 10,
    "fpsActual": 6.24,
    "frameCount": 19,
    "timestampsMs": [0, 163, 326],
    "format": "gif",
    "filmstrip": { "file": "frames.png", "cells": [] }
  }
}
```

`fpsActual` is calculated from measured frame timestamps, never copied from the
requested FPS. `durationActualMs` is the measured length of the whole recording
window, so it stays close to `durationRequestedMs` even when a limit reduced the
frame count: the last captured frame is held for the remaining time instead of a
second capture pass. `timestampsMs` is what tells you when frames actually
landed.

Errors are also terminal results and do not include stack traces:

```json
{
  "schemaVersion": 1,
  "protocolVersion": 1,
  "runId": "abc123",
  "status": "error",
  "operation": "capture",
  "name": "dashboard",
  "error": {
    "code": "TARGET_NOT_FOUND",
    "message": "SnapEye target was not found: #dashboard"
  }
}
```

Stable error codes include `INVALID_RUN_ID`, `INVALID_NAME`,
`TARGET_NOT_FOUND`, `BASELINE_NOT_FOUND`, `BASELINE_INCOMPATIBLE`,
`CAPTURE_FAILED`, `DIFF_FAILED`, `RECORD_FAILED`, and `PERSIST_FAILED`.

## Artifact layout

```text
.snapeye/
  .gitignore
  baselines/
    dashboard.png
    dashboard.json
  runs/
    abc124/
      current.png
      diff.png
      result.json
    abc125/
      recording.gif
      recording.webm
      frames.png
      result.json
```

SnapEye ensures these entries exist in `.snapeye/.gitignore` without replacing
anything already there:

```gitignore
runs/
*.tmp
```

On Vite startup, only old, real directories directly inside `runs/` are pruned.
SnapEye never prunes `baselines/` and refuses symlink escapes.

## Security and persistence

All mutating V1 routes require an ephemeral token injected by the Vite plugin.
The middleware validates methods, content types, request sizes, run IDs, names,
and a fixed artifact filename allowlist. Files are written only under the
configured artifact root. `result.json` is single-assignment and published
atomically after every other artifact, so observing it means the run is
terminal. Baseline replacements are serialized by name; their JSON sidecar is
the commit marker and binds the PNG by size and SHA-256 so interrupted or mixed
pairs are rejected rather than compared.

SnapEye is still a local development tool. Do not expose the Vite development
server to untrusted networks.

## Compatibility and migration from 0.1

- `attachSnapEye()` remains available.
- `window.snapeye.snap()` remains an alias of `capture()`.
- Console forwarding and the error overlay remain available.
- The legacy `createSnapEyeHandler()` export remains for existing flat capture
  integrations under `/__snapeye__`.
- `attachSnapEye({ snapdom })` without a V1 store automatically selects that
  legacy capture-only bridge; `legacy: true` can also be explicit.
- V1 does not preserve the old flat `.snapeye/<name>.png` layout. Baselines now
  live in `baselines/`, and every terminal result is isolated under a caller's
  run ID.

The legacy handler does not implement diff, record, V1 isolation, terminal
results, or token security. New Vite projects should use `snapeye()` exclusively.

## Scope

SnapEye V1 deliberately contains no model, prompt, API key, navigation, form
interaction, authentication system, MCP server, cloud service, dashboard,
remote history, PR comments, CI orchestration, Tauri adapter, or Electron
adapter. Those concerns belong to the agent or host environment.

The CLI is not an exception: it opens one URL and waits for one file. It does
not navigate, interact, or decide anything. Getting the app into the right state
remains the agent's job.

## License

[MIT](LICENSE) — © [Zumerlab](https://github.com/zumerlab)
