/**
 * Capture stability — the reason two captures of an unchanged page produce the
 * same pixels.
 *
 * A visual toolbelt that reports a change nobody made is worse than no toolbelt
 * at all: the agent chases a phantom, "fixes" working code, and stops trusting
 * every later result. Anything whose appearance depends on *when* it was
 * captured has to be pinned before SnapDOM serializes the target:
 *
 *   - infinite animations (spinners, pulses, marquees) are rewound to their
 *     first frame, so every run captures the same frame rather than whichever
 *     one the clock happened to land on;
 *   - finite animations and in-flight transitions are fast-forwarded to the
 *     state they were heading to, which is the settled appearance a developer
 *     would call correct;
 *   - a stylesheet stops anything that tries to start while the capture runs.
 *
 * Order matters, and it was measured rather than assumed. Pausing through the
 * Web Animations API first does not hold: the CSS `animation-play-state`
 * property re-takes control on the next style resolution and the animation
 * advances one frame past the rewind. Installing the stylesheet first, letting
 * it apply, and only then rewinding is what actually pins the frame.
 *
 * Everything is restored afterwards: this runs against the developer's live
 * page, not a throwaway one. `record` never stabilizes — motion is its subject.
 */

const FREEZE_ATTRIBUTE = 'data-snapeye-freeze'
const FREEZE_CSS = `*, *::before, *::after {
  animation-play-state: paused !important;
  transition-property: none !important;
}`

/**
 * Pin every time-dependent visual on the page.
 *
 * @param {Document} documentImpl
 * @param {{window?: Window, wait?: (ms:number) => Promise<void>}} [deps]
 * @returns {Promise<() => void>} restores the page to how it was found
 */
export async function freezeMotion (documentImpl, { window: windowImpl, wait } = {}) {
  // Applying the stylesheet changes CSS animations' reported playState to
  // paused. Remember their live state before that change so restoration does
  // not turn a running animation into a permanently paused one.
  const original = new Map(listAnimations(documentImpl).map(animation => [animation, {
    animation,
    currentTime: readCurrentTime(animation),
    playState: animation.playState
  }]))
  const style = injectFreezeStyle(documentImpl)
  const entries = []
  try {
    // Let the paused property reach the animations before rewinding them.
    await nextFrames(windowImpl, wait, 2)
    for (const animation of listAnimations(documentImpl)) {
      const entry = original.get(animation) || {
        animation,
        currentTime: readCurrentTime(animation),
        playState: animation.playState
      }
      // Rewinding can succeed even when pause() then throws. Such partial
      // changes still need to be undone.
      entries.push(entry)
      try {
        if (isEndless(animation)) {
          // A phase is only reproducible if it is chosen, not observed.
          animation.currentTime = 0
          animation.pause()
        } else {
          animation.finish()
        }
      } catch {
        // Some animations refuse both (idle, zero-duration, replaced). They
        // are not a reason to abandon the rest of the page.
      }
    }
  } catch (error) {
    restoreMotion()
    throw error
  }

  return restoreMotion

  function restoreMotion () {
    try { style?.remove() } catch {}
    for (const entry of entries.reverse()) {
      try {
        if (entry.currentTime != null) entry.animation.currentTime = entry.currentTime
        if (entry.playState === 'running') entry.animation.play()
        else if (entry.playState === 'paused') entry.animation.pause()
      } catch {}
    }
    entries.length = 0
  }
}

/**
 * Wait until the page stops changing, or until the budget runs out.
 *
 * A fixed delay after DOMContentLoaded is a guess, and on a real framework page
 * it is the wrong one: the first request to a cold dev server spends seconds
 * compiling modules and hydrating islands, while every later request is warm and
 * settles in milliseconds. Capture the baseline on the first and the diffs on
 * the rest and you get a constant, entirely fake change — measured at 9 false
 * positives out of 12 on a real Astro site before this existed, and 0 after.
 *
 * The signature is geometry only, so a page animating colours or canvas pixels
 * reads as settled immediately and costs three frames; only a page still growing
 * spends the budget.
 *
 * @param {{document: Document, window: Window, element?: Element, budgetMs?: number, wait?: Function}} deps
 */
export async function waitForSettled ({ document, window: windowImpl, element, budgetMs = 2500, wait }) {
  if (!document || !(budgetMs > 0)) return
  const now = () => (windowImpl?.performance?.now?.() ?? Date.now())
  const deadline = now() + budgetMs
  let previous = null
  let stable = 0

  while (stable < 3) {
    await nextFrames(windowImpl, wait, 1)
    const signature = pageSignature(document, element)
    if (signature === previous) stable++
    else { stable = 0; previous = signature }
    if (now() >= deadline) return
  }
}

function pageSignature (document, element) {
  const root = document.documentElement
  const parts = [
    document.readyState,
    root?.scrollWidth,
    root?.scrollHeight,
    document.images?.length,
    document.styleSheets?.length
  ]
  if (element?.getBoundingClientRect) {
    const rect = element.getBoundingClientRect()
    parts.push(Math.round(rect.width), Math.round(rect.height))
  }
  return parts.join('x')
}

/**
 * Hold the operation until the page says it is ready.
 *
 * @param {number|string|null|undefined} spec milliseconds, or a CSS selector
 *   that must match before continuing
 * @param {{document: Document, wait: (ms:number) => Promise<void>, now: () => number, timeoutMs?: number}} deps
 */
export async function waitForReady (spec, { document, wait, now, timeoutMs = 5000 }) {
  if (spec == null || spec === '') return

  const milliseconds = asMilliseconds(spec)
  if (milliseconds != null) {
    if (milliseconds > 0) await wait(milliseconds)
    return
  }

  const selector = String(spec)
  const deadline = now() + timeoutMs
  for (;;) {
    let found = null
    try {
      found = document.querySelector(selector)
    } catch {
      throw waitError(`SnapEye cannot wait for an invalid selector: ${selector}`)
    }
    if (found) return
    if (now() >= deadline) {
      throw waitError(`SnapEye waited ${timeoutMs}ms for ${selector} and it never appeared`)
    }
    await wait(50)
  }
}

/** Milliseconds when `spec` is a number or a numeric string, otherwise null. */
function asMilliseconds (spec) {
  if (typeof spec === 'number') return Number.isFinite(spec) && spec >= 0 ? spec : null
  if (typeof spec === 'string' && /^\d+(\.\d+)?$/.test(spec.trim())) return Number(spec)
  return null
}

async function nextFrames (windowImpl, wait, count) {
  for (let i = 0; i < count; i++) {
    if (typeof windowImpl?.requestAnimationFrame === 'function') {
      await nextFrame(windowImpl)
    } else if (typeof wait === 'function') {
      await wait(16)
    } else {
      return
    }
  }
}

function nextFrame (windowImpl) {
  // Background documents may never receive animation frames. A timer keeps
  // stability waits bounded while foreground frames still resolve normally.
  const schedule = windowImpl.setTimeout?.bind(windowImpl) || globalThis.setTimeout
  const cancel = windowImpl.clearTimeout?.bind(windowImpl) || globalThis.clearTimeout
  return new Promise((resolve, reject) => {
    let frame
    const timer = schedule(() => {
      try { windowImpl.cancelAnimationFrame?.(frame) } catch {}
      resolve()
    }, 100)
    try {
      frame = windowImpl.requestAnimationFrame(() => {
        cancel(timer)
        resolve()
      })
    } catch (error) {
      cancel(timer)
      reject(error)
    }
  })
}

function listAnimations (documentImpl) {
  if (typeof documentImpl?.getAnimations !== 'function') return []
  try {
    return Array.from(documentImpl.getAnimations()).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * True when the animation never ends on its own, so `finish()` would throw and
 * no "settled" state exists to fast-forward to.
 */
function isEndless (animation) {
  let timing
  try {
    timing = animation.effect?.getComputedTiming?.()
  } catch {}
  if (!timing) return true
  if (!Number.isFinite(timing.iterations)) return true
  return !Number.isFinite(timing.duration)
}

function readCurrentTime (animation) {
  try {
    return animation.currentTime
  } catch {
    return null
  }
}

function injectFreezeStyle (documentImpl) {
  const host = documentImpl?.head || documentImpl?.documentElement
  if (!host || typeof documentImpl.createElement !== 'function' || typeof host.appendChild !== 'function') {
    return null
  }
  try {
    const style = documentImpl.createElement('style')
    style.setAttribute(FREEZE_ATTRIBUTE, '')
    style.textContent = FREEZE_CSS
    host.appendChild(style)
    return style
  } catch {
    return null
  }
}

function waitError (message) {
  const error = new Error(message)
  error.code = 'CAPTURE_FAILED'
  error.publicMessage = message
  return error
}

export { FREEZE_ATTRIBUTE, FREEZE_CSS }
