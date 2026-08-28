/**
 * Metric helpers — every number SnapEye publishes is computed here so the
 * definitions live in exactly one place (and can be unit tested without a
 * browser).
 */
import { RECORD_LIMITS } from './protocol.js'

/**
 * Effective raster scale of a capture: raster pixels per CSS pixel.
 * Measured from the produced image, never assumed from the requested option —
 * snapDOM may clamp, and regions must map onto the file that actually exists.
 */
export function computeScale ({ pixelWidth, cssWidth, pixelHeight, cssHeight }) {
  const byWidth = positiveRatio(pixelWidth, cssWidth)
  const byHeight = positiveRatio(pixelHeight, cssHeight)

  if (byWidth && byHeight) {
    // Integer raster dimensions can introduce up to roughly one pixel of
    // rounding error. Anything beyond that plus 1% is genuinely anisotropic
    // and cannot be represented by the single scale used for region mapping.
    const roundingTolerance = Math.max(1 / Number(cssWidth), 1 / Number(cssHeight))
    const relativeTolerance = Math.max(byWidth, byHeight) * 0.01
    if (Math.abs(byWidth - byHeight) > roundingTolerance + relativeTolerance) {
      const err = new RangeError(
        `SnapEye capture has anisotropic raster scale (${round(byWidth, 4)}x horizontally, ` +
        `${round(byHeight, 4)}x vertically)`
      )
      err.code = 'ANISOTROPIC_SCALE'
      err.details = {
        scaleX: round(byWidth, 4),
        scaleY: round(byHeight, 4)
      }
      throw err
    }
  }

  const scale = byWidth || byHeight || 1
  // Snap to 4 decimals: keeps 1.9999999 from leaking into JSON.
  return round(scale, 4)
}

/** Image block published in every successful result. */
export function buildImageMeta ({ cssWidth, cssHeight, pixelWidth, pixelHeight }, coordinateSpace) {
  return {
    coordinateSpace,
    cssWidth: round2(cssWidth),
    cssHeight: round2(cssHeight),
    pixelWidth,
    pixelHeight,
    scale: computeScale({ pixelWidth, cssWidth, pixelHeight, cssHeight })
  }
}

/**
 * Fraction of compared raster pixels that changed, always 0..1.
 * Anti-aliasing pixels are excluded by snapDiff before they reach here.
 */
export function computeChangedRatio (changedPixels, totalPixels) {
  if (!(totalPixels > 0)) return 0
  const ratio = changedPixels / totalPixels
  if (!Number.isFinite(ratio)) return 0
  return clamp(round(ratio, 6), 0, 1)
}

/**
 * Real frame rate, derived from the recorded timestamps rather than the
 * requested fps: (frames - 1) / elapsed seconds.
 */
export function computeFpsActual (timestampsMs) {
  if (!Array.isArray(timestampsMs) || timestampsMs.length < 2) return 0
  const first = timestampsMs[0]
  const last = timestampsMs[timestampsMs.length - 1]
  const elapsed = (last - first) / 1000
  if (!(elapsed > 0)) return 0
  return round((timestampsMs.length - 1) / elapsed, 2)
}

/** Wall-clock span actually covered by the frame sequence. */
export function computeDurationActual (timestampsMs) {
  if (!Array.isArray(timestampsMs) || timestampsMs.length === 0) return 0
  return Math.round(timestampsMs[timestampsMs.length - 1] - timestampsMs[0])
}

/**
 * Normalise `record` options against the documented limits and the memory
 * budget. Returns the values actually used, so the caller can report both what
 * was requested and what was run.
 */
export function clampRecordOptions (options = {}, targetSize = null) {
  const L = RECORD_LIMITS
  const durationRequestedMs = numberOr(options.duration, L.defaultDurationMs)
  const fpsRequested = numberOr(options.fps, L.defaultFps)
  const scaleRequested = numberOr(options.scale, L.defaultScale)

  const duration = clamp(Math.round(durationRequestedMs), L.minDurationMs, L.maxDurationMs)
  const fps = clamp(round(fpsRequested, 2), L.minFps, L.maxFps)
  let scale = clamp(scaleRequested, L.minScale, L.maxScale)

  const requestedFrameCount = Math.max(1, Math.round((duration / 1000) * fps))
  let frameCount = Math.min(requestedFrameCount, L.maxFrames)
  const initialScale = scale
  const initialFrameCount = frameCount
  let estimatedTotalPixels = null

  // Memory guard: a big target at a high frame count can pin hundreds of MB of
  // canvases. Shrink scale first (cheap, still readable), then frames.
  if (hasFiniteSize(targetSize)) {
    const width = Number(targetSize.width)
    const height = Number(targetSize.height)
    const perFrame = width * height
    let budgetFrames = Math.floor(L.maxTotalPixels / (perFrame * scale * scale))
    while (budgetFrames < frameCount && scale > L.minScale) {
      const nextScale = round(Math.max(L.minScale, scale / 2), 4)
      if (nextScale === scale) break
      scale = nextScale
      budgetFrames = Math.floor(L.maxTotalPixels / (perFrame * scale * scale))
    }
    if (budgetFrames < 1) {
      const minimumFramePixels = Math.ceil(perFrame * scale * scale)
      const err = new RangeError(
        `SnapEye record target exceeds the ${L.maxTotalPixels}-pixel memory budget ` +
        `for even one frame at scale ${scale}`
      )
      err.code = 'RECORD_BUDGET_EXCEEDED'
      err.details = {
        width,
        height,
        scale,
        minimumFramePixels,
        maxTotalPixels: L.maxTotalPixels
      }
      throw err
    }
    if (budgetFrames < frameCount) frameCount = budgetFrames
    estimatedTotalPixels = Math.ceil(perFrame * scale * scale * frameCount)
  }

  // When a ceiling lowers the frame count, distribute the retained samples
  // across the whole recording instead of capturing a short burst and then
  // leaving the final frame frozen for most of the requested duration.
  const intervalMs = frameCount === 1
    ? duration
    : frameCount < requestedFrameCount
      ? duration / frameCount
      : 1000 / fps

  return {
    durationRequestedMs: Math.round(durationRequestedMs),
    fpsRequested: round(fpsRequested, 2),
    scaleRequested: round(scaleRequested, 4),
    durationMs: duration,
    fps,
    scale,
    frameCount,
    intervalMs: round(intervalMs, 3),
    captureFps: round(1000 / intervalMs, 2),
    budgetLimited: scale !== initialScale || frameCount !== initialFrameCount,
    estimatedTotalPixels,
    maxTotalPixels: L.maxTotalPixels
  }
}

function positiveRatio (numerator, denominator) {
  const n = Number(numerator)
  const d = Number(denominator)
  if (!Number.isFinite(n) || !Number.isFinite(d) || n <= 0 || d <= 0) return 0
  return n / d
}

function hasFiniteSize (size) {
  if (!size || typeof size !== 'object') return false
  const width = Number(size.width)
  const height = Number(size.height)
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
}

function numberOr (value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function clamp (value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function round (value, digits) {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

function round2 (value) {
  return Math.round(Number(value) * 100) / 100
}
