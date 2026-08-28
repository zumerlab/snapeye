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
