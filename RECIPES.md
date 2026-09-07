# SnapEye agent recipes

These recipes stay inside SnapEye's capture, diff, and fixed-duration record
scope. The agent remains responsible for navigation and interaction.

Every command prints `result.json` to stdout and exits `0` (ok), `1` (the run
failed), `2` (SnapEye or the dev server is not running), or `3` (`--fail-on-change`
and the diff changed).

## Approve a baseline, make a change, compare

```sh
npx snapeye capture dashboard --target '#dashboard' --url http://localhost:5173/dashboard
# edit the application, then:
npx snapeye diff dashboard --target '#dashboard' --url http://localhost:5173/dashboard --fail-on-change
```

Exit `0` means nothing moved and no image needs to be opened. Exit `3` means the
diff found something: use `diff.regions` from the JSON to decide whether to open
`diff.png`.

## Branch on the result inside a script

```sh
if npx snapeye diff header --target '#site-header' --fail-on-change > /tmp/r.json; then
  echo "header unchanged"
else
  case $? in
    3) jq '.diff.regions' /tmp/r.json ;;
    1) jq -r '.error.code' /tmp/r.json ;;
    2) echo "SnapEye is not running" ;;
  esac
fi
```

## Target one component

```sh
npx snapeye capture profile-card --target '#profile-card' --url http://localhost:5173/settings
```

Dimensions and diff regions use that target's axis-aligned capture viewport, not
the page viewport.

## A state that only exists after an interaction

The URL trigger reloads the page, so it cannot reach a state produced by a
click. Drive the page with the agent's browser and call the API, which returns
the result inline:

```js
await page.goto('http://localhost:5173/settings')
await page.click('#open-billing-modal')
const result = await page.evaluate(() => window.snapeye.diff('billing-modal', '#modal'))
// result.status, result.diff.changed, result.diff.regions — no polling, no file read
```

## Content that keeps moving

A `<canvas>` render loop or a chart animating through `requestAnimationFrame` is
not pinned by SnapEye's motion freeze. Capture at a known point instead:

```sh
npx snapeye diff chart --target '#chart' --wait '#chart.is-rendered'
npx snapeye diff chart --target '#chart' --wait 500
```

CSS animations and transitions need none of this: they are pinned automatically.

## Inspect an animation once

```sh
npx snapeye record loading-state --target '#loader' --duration 2500 --fps 12 --format gif
```

Read `frames.png` first for a bounded overview, and use `record.filmstrip.cells`
to map a cell back to its frame and timestamp. Open `recording.gif` only when
the contact sheet is not enough. Add `--format both` for a native video artifact
as well; both media artifacts and the filmstrip come from the same captured
frames.

## Let the agent's own browser open the URL

```sh
npx snapeye diff dashboard --target '#dashboard' --no-open
# prints the trigger URL to stderr, then waits for the terminal result
```

The agent navigates to the printed URL with whatever browser tool it has; the
CLI still does the polling and prints the result.

## Check the environment before trusting a verdict

```sh
curl -fsS http://localhost:5173/__snapeye/health
```

An agent that gets exit code `2` from any command should report that the SnapEye
environment is not running rather than continue without visual verification.

## A page with no dev server: an issue repro, a scratch file, a static export

`--serve` hosts the file for the length of one run. Nothing to install in the
page, nothing to configure; the client is injected the same way the Vite plugin
does it.

```sh
npx snapeye capture issue-493 --serve repro/issue.html --target '#test'
```

Pass a directory to serve its `index.html`. To keep the server up for several
operations, use `serve` on its own and point the others at the URL it prints:

```sh
npx snapeye serve repro/issue.html &          # prints {"url": "http://127.0.0.1:5173/issue.html", ...}
npx snapeye capture issue-493 --url http://127.0.0.1:5173/issue.html --target '#test'
```

## Verify a SnapDOM fix before it is published

`--snapdom` points the injected client, and any `<script>` on the page that
loads SnapDOM from unpkg or jsDelivr, at a local build:

```sh
npx snapeye capture issue-493 --serve repro/issue.html --snapdom ../snapdom/dist --target '#test'
```

It accepts the `dist/` directory, the package root, `snapdom.mjs`, or
`snapdom.js`; the ESM build is required, the IIFE is used when the page has a
CDN script tag.

## A/B two capture configurations

`--snapdom-options` applies a JSON object of SnapDOM options to that run only.
Capture once, then diff with the other configuration: `changed: false` means
the option had no effect on the pixels, which is usually the bug.

```sh
npx snapeye capture fonts --serve repro/issue.html --target '#test' --snapdom-options '{"embedFonts":true}'
npx snapeye diff    fonts --serve repro/issue.html --target '#test' --snapdom-options '{"embedFonts":false}' --fail-on-change
```

Exit `3` here is the expected outcome: embedding the fonts changed the render.
Exit `0` means both configurations produced the same image, so the fonts were
never embedded at all.

## Read the SVG before the pixels

Every capture and diff keeps `current.svg` in the run directory: the exact SVG
SnapDOM rasterized. The PNG says that a capture looks wrong; the SVG says why.
`timing.captureMs` in `result.json` is the time SnapDOM itself took.

```sh
run=$(jq -r .runId /tmp/r.json)
grep -c '@font-face' .snapeye/runs/$run/current.svg     # 0 with embedFonts: true is the bug
grep -o 'url(data:font[^)]\{0,30\}' .snapeye/runs/$run/current.svg | head
grep -c '<image' .snapeye/runs/$run/current.svg
```

A capture that finished in a few milliseconds with zero `@font-face` did not
fetch anything. Add `--no-svg` to skip the file when runs are frequent and the
SVG is large.

## When fidelity itself is in doubt, pair with a real screenshot

SnapEye captures through SnapDOM, so it cannot show what the live page looks
like; a diff compares two SnapDOM renders. When the question is "does the
capture match the browser", take a screenshot of the real window and compare it
by eye or with your own diff:

```sh
# macOS: the window id of the tab you opened
osascript -e 'tell application "Google Chrome" to id of window 1' | xargs -I{} screencapture -l {} /tmp/live.png
```

Any browser tool that returns a screenshot works the same way. Keep the capture
and the screenshot at the same zoom and device pixel ratio.
