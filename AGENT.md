# SnapEye contributor guide

SnapEye is a deterministic visual toolbelt for coding agents:

> Capture. Compare. Record. Visual tools for coding agents.

It is not an agent. Keep models, prompts, navigation, clicks, authentication,
cloud storage, CI orchestration, MCP, dashboards, and PR comments out of this
package.

## Architecture

```text
CLI (optional) ─┐
                ├─> trigger URL / window.snapeye
agent browser ──┘
        -> in-page runtime
        -> ArtifactStore interface
        -> same-origin HTTP transport
        -> Vite middleware
        -> filesystem store
        -> .snapeye/
```

The CLI is a client of the same URL protocol an agent would drive by hand: it
checks health, mints a run id, opens one URL, and polls for the terminal result.
It must never grow navigation, interaction, or judgement.

Capture, diff, and record must depend on the `ArtifactStore` contract, not on
Vite or Node paths. The Vite plugin is the only V1 host adapter.

The contract is:

```ts
interface ArtifactStore {
  readBaseline(name: string): Promise<StoredBaseline | null>
  writeBaseline(name: string, baseline: StoredBaseline): Promise<void>
  writeRunArtifact(
    runId: string,
    filename: string,
    data: Blob | Uint8Array | string
  ): Promise<void>
  commitResult(runId: string, result: SnapEyeResult): Promise<void>
}
```

`commitResult()` is single-assignment, atomic, and always the final write. A
visible `result.json` means a run is terminal.

## Non-negotiable invariants

- A URL-triggered operation requires a caller-supplied, validated `runId`.
- Results exist only at `.snapeye/runs/<runId>/result.json`.
- Invalid IDs are rejected, never sanitized into a different path.
- All filesystem operations remain inside the configured root and reject
  symlink escapes.
- Baselines are committable and pruning never touches them.
- Diff regions use CSS pixels in the target's axis-aligned capture viewport;
  `image.scale` maps that viewport to raster pixels.
- `changedRatio` is a number from 0 to 1.
- Recording uses one shared frame sequence for media, filmstrip, timestamps,
  and metrics.
- GIF/video adapters never recapture the live target.
- Errors are terminal when a valid run namespace exists and never publish stack
  traces.
- The Vite client token is ephemeral and never appears in health or public
  runtime options.
- The plugin uses `apply: 'serve'` and leaves production builds untouched.
- Injection is universal and belongs to SnapEye, not to an adapter and never to
  the agent. `transformIndexHtml` only covers HTML Vite itself serves, so the
  plugin rewrites any HTML the dev server sends. Do not answer a new host with a
  new adapter; make the injector handle it. Two things it must keep handling,
  both found on a real Astro site: chunks arrive as `Uint8Array` (a web
  ReadableStream, not `Buffer`), and the content type is declared through
  `writeHead()`, which `getHeader()` never reports.
- The failure mode is silent and expensive — health says `ok`, `window.snapeye`
  does not exist, and every operation burns its full timeout. Any change to
  injection must be verified against a framework-rendered page, not the fixture:
  `curl -s -H 'Accept: text/html' localhost:PORT | grep -c data-snapeye-client`.
- Every capture waits for the page to go quiet before shooting. The first
  request to a cold dev server renders differently from every warm one; on a
  real Astro site that alone produced 9 false positives out of 12.
- The automatically injected client has no in-page side effects unless the
  developer opts in through `snapeye({ client })`: no console patching, no
  overlay, no hotkey. Anything that writes a baseline must be deliberate, and a
  keystroke aimed at an editable element is never one.
- Plugin options are validated: unknown or malformed keys throw rather than
  being silently dropped.
- `capture` and `diff` pin motion before capturing; `record` never does. The
  stylesheet goes in before the rewind, because a Web Animations pause alone
  does not hold — the CSS `animation-play-state` property re-takes control on
  the next style resolution and the animation slips a frame. This was measured,
  not assumed: 7 false positives in 8 runs before, 0 in 12 after.
- A false "changed" is the worst defect this package can ship. Anything that
  makes an unchanged page report a change is a release blocker.

## Public API compatibility

Keep `attachSnapEye()` useful, retain `window.snapeye.snap()` as an alias of
`capture()`, and preserve console forwarding where it does not weaken V1.
`createSnapEyeHandler()` remains a legacy flat-output adapter; do not route new
V1 behavior through its insecure contract.

The old `.snapeye/<name>.png` layout is not a V1 compatibility constraint.

## SnapDOM

Keep the development dependency on the current published SnapDOM release and
the peer range compatible with v2 and v3 prereleases. The browser suite accepts
`SNAPDOM_TEST_PATH` for an explicit compiled v3 build and `SNAPDOM_EXPECTED_MAJOR=3`
to assert that it really loaded it. `SNAPDOM_PLUGINS_TEST_PATH` enables the opt-in
redaction composition regression with the matching v3 plugins. Do not modify SnapDOM core. SnapDiff
owns pixel comparison. The local GIF/video adapters consume frames already
captured with SnapDOM because the current upstream exporters recapture the live
element and do not accept a shared frame sequence.

## Before handing off a change

Run:

```sh
npm test          # skips the browser suite loudly when no Chrome is present
npm run test:browser  # same suite, but a missing browser is a failure
npm run test:types
npm run build
npm run test:pack # packed consumer; optional SNAPDOM_PACKAGE_PATH selects a local core tarball
```

Also verify the Vite fixture in a real browser when runtime, injection, capture,
diff, record, or transport behavior changes. Read `result.json` before images.

## Before a release: install the package, do not trust the repo

Two bugs have already reached this point invisible to the whole suite, because
inside the repo every dependency resolves differently than it does in a real
project: a default import of `gifenc` that only fails once a bundler picks its
CommonJS build, and client dependencies that Vite's scanner never discovers and
therefore serves unbundled. Both killed the in-page client completely, and both
looked green here.

So before publishing, install the packed tarball into a throwaway app and run
the real flow:

```sh
npm pack --pack-destination /tmp/fresh
cd /tmp/fresh && npm install ./zumer-snapeye-*.tgz @zumer/snapdom vite
# vite.config.js with plugins: [snapeye()], one index.html with a target
npx vite &
npx snapeye capture panel --target '#card'
npx snapeye diff panel --target '#card' --fail-on-change
npx snapeye record panel --target '#card' --duration 800 --fps 5
```

Watch the browser console: any page error means the injected client never
attached, and every operation will time out with exit code 2.
