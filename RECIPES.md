# SnapEye recipes — extend without forking

The core of `@zumer/snapeye` is two HTTP endpoints and one client
method. Everything below is **off the main contract** — patterns we
built and parked rather than ship as features.

Each recipe pairs SnapEye with one external package, adds one new
endpoint and one new client method, and lives in your project (not in
this library). Working source for all three is on the
[`agent-modes`](https://github.com/zumerlab/snapeye/tree/agent-modes)
branch — copy the diff into your fork, or use it as reference.

If a recipe earns real users, it graduates to its own package
(`@zumer/snapeye-recipes-*`) instead of bloating the core.

---

## 1. agent-map — Set-of-Mark for visual agents

**Use when**: your agent is going to *act* on the page (click, type,
navigate) — not just look at it. Plain `snap()` gives the agent eyes;
this gives it numbered handles plus a JSON lookup of bbox + role +
state per interactive element, so "click 3" becomes a deterministic
coordinate lookup instead of pixel-estimation from the PNG.

**Cost**: peer-dep on
[`@zumer/snapdom-plugins`](https://www.npmjs.com/package/@zumer/snapdom-plugins).
New endpoint `POST /__snapeye__/map` accepting JSON
`{image, map, dimensions}`. New client method `snapMap(name, target?)`.

**Skip when**: pure debugging ("did my CSS break?"). The red numbered
badges actively obscure content — they're noise unless you're acting.

```js
// Browser
import { snapdom }       from '@zumer/snapdom'
import { agentMap }      from '@zumer/snapdom-plugins/agent-map'
import { attachSnapEye } from '@zumer/snapeye/client'

attachSnapEye({ snapdom, agentMap })

window.snapeye.snapMap('login')
// or  open http://localhost:8080/?snapmap=login
```

Writes `.snapeye/login.png` (annotated) + `.snapeye/login.map.json`:

```json
{
  "dimensions": { "width": 1024, "height": 768 },
  "map": [
    { "i": 0, "n": "Sign in", "r": "button",  "b": [120, 240, 80, 32] },
    { "i": 1, "n": "Email",   "r": "textbox", "b": [120, 180, 200, 32],
      "s": { "value": "user@example.com" } }
  ]
}
```

Server-side wiring (one extra route): see
[`src/server.js` on `agent-modes`](https://github.com/zumerlab/snapeye/blob/agent-modes/src/server.js).

---

## 2. snapdiff — pixel-diff vs the previous capture

**Use when**: your agent iterates on a change AND needs a yes/no on
"did anything visible change". After two captures with the same name,
the JSON's `ratio` is single-glance: `0.0` = nothing moved (refactor
was visually neutral, or non-rendering edit); `0.05` = 5 % of pixels
shifted, look at the diff PNG to see where.

**Cost**: peer-dep on
[`@zumer/snapdiff`](https://www.npmjs.com/package/@zumer/snapdiff).
New endpoint `POST /__snapeye__/diff` (and a `GET /__snapeye__/prev`
so the browser can pull the baseline). New client method
`snapDiff(name, target?)`.

**Skip when**: ad-hoc capture without a stable name — the first call
to a given name has no baseline and is just a `snap()` with extra
ceremony.

```js
// Browser
import { snapdom }       from '@zumer/snapdom'
import { diffCanvas }    from '@zumer/snapdiff/diff'
import { attachSnapEye } from '@zumer/snapeye/client'

attachSnapEye({ snapdom, diffCanvas })

window.snapeye.snapDiff('home')
// or  open http://localhost:8080/?snapdiff=home
```

After two calls, `.snapeye/` contains: `home.png` (current),
`home.prev.png` (rotated baseline), `home.diff.png` (red-overlay diff),
`home.diff.json` (`{ ratio, mismatched, totalPixels, dimsMatch, … }`).

Server-side wiring: see
[`src/server.js` on `agent-modes`](https://github.com/zumerlab/snapeye/blob/agent-modes/src/server.js)
(the `/diff` and `/prev` routes; rotation of `X.png → X.prev.png`).

---

## 3. namespace — multi-agent isolation

**Use when**: two or more agents drive the same dev server in parallel
and would otherwise clobber each other's `.snapeye/<name>.png`.

**Cost**: ~10 server lines, ~5 client lines. Default behaviour is
identical to the current one — only paid when used.

**Skip when**: you only ever have one capturing client. Two
`createSnapEyeHandler({ dir })` instances pointing at different output
directories also solve this without touching the code.

```js
// Server — default namespace for this handler instance:
createSnapEyeHandler({ dir: '.snapeye', namespace: process.env.AGENT_ID })

// Or per-request from the URL:
//   open "http://localhost:8080/?snap=home&namespace=agent-a"
//   → writes .snapeye/agent-a/home.png
```

Source on the `agent-modes` branch — see
[`src/server.js`](https://github.com/zumerlab/snapeye/blob/agent-modes/src/server.js)
and [`src/client.js`](https://github.com/zumerlab/snapeye/blob/agent-modes/src/client.js).

---

## Why these aren't in core

The two-endpoint contract is the only thing the README guarantees.
Adding map / diff / namespace would each:

- enlarge the surface a reader has to understand,
- add a peer-dep most consumers don't need,
- couple SnapEye's release cadence to a partner project.

When one of these recipes gets enough pull from real users, it gets
extracted to its own package (`@zumer/snapeye-agent-map`,
`@zumer/snapeye-snapdiff`, etc.) and the core stays as-is.
