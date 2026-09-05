/**
 * Region extraction — turns a binary "this pixel changed" mask into the small
 * list of rectangles an agent can act on.
 *
 * Pure and DOM-free so it can be unit tested directly. The pixel work itself
 * belongs to snapDiff; this module only *adapts* its output:
 *
 *   mask (raster px) -> tiles -> clusters -> bounding boxes -> CSS px
 *
 * Every rectangle SnapEye publishes is expressed in CSS pixels relative to the
 * axis-aligned capture viewport SnapDOM produced for the target. For an
 * untransformed target this begins at its top-left edge; root transforms can
 * expand the viewport. `result.image.scale` converts back to file pixels:
 * filePx = cssPx * scale.
 */
import { DIFF_DEFAULTS } from './protocol.js'

/**
 * Build a binary mask from the RGBA buffer snapDiff rendered.
 *
 * snapDiff paints changed pixels with `diffColor` (default pure red), likely
 * anti-aliasing artefacts with `aaColor` (yellow) and everything else as a
 * grey wash (r === g === b), so an exact colour match is unambiguous.
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba rendered diff buffer
 * @param {number[]} [diffColor] RGB triplet used for changed pixels
 * @returns {Uint8Array} one byte per pixel, 1 = changed
 */
export function maskFromDiffBuffer (rgba, diffColor = [255, 0, 0]) {
  const [r, g, b] = diffColor
  const mask = new Uint8Array(rgba.length / 4)
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    // A diff mask leaves unchanged pixels transparent. Their RGB bytes can
    // still match a custom diffColor (notably black) without being a change.
    if (rgba[i + 3] > 0 && rgba[i] === r && rgba[i + 1] === g && rgba[i + 2] === b) mask[p] = 1
  }
  return mask
}

/**
 * Cluster a mask into CSS-pixel regions.
 *
 * @param {Uint8Array} mask one byte per raster pixel, 1 = changed
 * @param {number} width raster width
 * @param {number} height raster height
 * @param {object} [options]
 * @param {number} [options.scale] raster px per CSS px (>= 0.01)
 * @returns {{regionCount:number, regionsTruncated:boolean, regions:Array}}
 */
export function extractRegions (mask, width, height, options = {}) {
  const {
    scale = 1,
    tileSize = DIFF_DEFAULTS.tileSize,
    gapTiles = DIFF_DEFAULTS.gapTiles,
    minRegionCssSide = DIFF_DEFAULTS.minRegionCssSide,
    minRegionCssArea = DIFF_DEFAULTS.minRegionCssArea,
    maxRegions = DIFF_DEFAULTS.maxRegions
  } = options

  assertOption('scale', scale, value => value > 0)
  assertOption('tileSize', tileSize, value => Number.isSafeInteger(value) && value >= 1)
  assertOption('gapTiles', gapTiles, value => Number.isSafeInteger(value) && value >= 0)
  assertOption('minRegionCssSide', minRegionCssSide, value => value >= 0)
  assertOption('minRegionCssArea', minRegionCssArea, value => value >= 0)
  assertOption('maxRegions', maxRegions, value => Number.isSafeInteger(value) && value >= 0)

  const boxes = clusterMask(mask, width, height, tileSize, gapTiles)

  const kept = []
  for (const box of boxes) {
    const css = rasterRectToCss(box, scale)
    const bigEnough = css.width >= minRegionCssSide || css.height >= minRegionCssSide
    if (!bigEnough) continue
    if (css.width * css.height < minRegionCssArea) continue
    kept.push(css)
  }

  // Largest first, then top-to-bottom / left-to-right: stable across runs.
  kept.sort((a, b) =>
    (b.width * b.height) - (a.width * a.height) || a.y - b.y || a.x - b.x)

  if (kept.length > maxRegions) {
    return {
      regionCount: kept.length,
      regionsTruncated: true,
      regions: [{ ...boundingBox(kept), aggregate: true }]
    }
  }

  return {
    regionCount: kept.length,
    regionsTruncated: false,
    regions: kept.map(r => ({ ...r, aggregate: false }))
  }
}

function assertOption (name, value, isValid) {
  if (!Number.isFinite(value) || !isValid(value)) {
    throw new RangeError(`Invalid SnapEye region option: ${name}`)
  }
}

/** Smallest rectangle containing every rectangle in `rects`. */
export function boundingBox (rects) {
  if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 }
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity
  for (const r of rects) {
    x1 = Math.min(x1, r.x)
    y1 = Math.min(y1, r.y)
    x2 = Math.max(x2, r.x + r.width)
    y2 = Math.max(y2, r.y + r.height)
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

/**
 * Convert a raster rectangle to whole CSS pixels, growing outwards so the
 * region never clips the change it describes.
 */
export function rasterRectToCss (rect, scale) {
  const s = scale > 0 ? scale : 1
  const x = Math.floor(rect.x / s)
  const y = Math.floor(rect.y / s)
  const right = Math.ceil((rect.x + rect.width) / s)
  const bottom = Math.ceil((rect.y + rect.height) / s)
  return { x, y, width: Math.max(right - x, 0), height: Math.max(bottom - y, 0) }
}

/**
 * Tile the mask, then flood-fill tiles that sit within `gapTiles` of each
 * other. Tiling keeps the cost proportional to the image area instead of the
 * number of changed pixels, and the gap merges text runs / icon clusters into
 * one region instead of dozens of glyph-sized boxes.
 */
function clusterMask (mask, width, height, tileSize, gapTiles) {
  const cols = Math.ceil(width / tileSize)
  const rows = Math.ceil(height / tileSize)
  if (!cols || !rows) return []

  // Per-tile bounding box of the changed pixels it actually holds.
  const hit = new Uint8Array(cols * rows)
  const minX = new Int32Array(cols * rows).fill(0)
  const minY = new Int32Array(cols * rows).fill(0)
  const maxX = new Int32Array(cols * rows).fill(0)
  const maxY = new Int32Array(cols * rows).fill(0)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue
      const t = Math.floor(y / tileSize) * cols + Math.floor(x / tileSize)
      if (!hit[t]) {
        hit[t] = 1
        minX[t] = x; maxX[t] = x; minY[t] = y; maxY[t] = y
      } else {
        if (x < minX[t]) minX[t] = x
        if (x > maxX[t]) maxX[t] = x
        if (y < minY[t]) minY[t] = y
        if (y > maxY[t]) maxY[t] = y
      }
    }
  }

  const seen = new Uint8Array(cols * rows)
  const boxes = []
  const stack = []

  for (let t = 0; t < hit.length; t++) {
    if (!hit[t] || seen[t]) continue
    seen[t] = 1
    stack.length = 0
    stack.push(t)
    let bx1 = minX[t]; let by1 = minY[t]; let bx2 = maxX[t]; let by2 = maxY[t]

    while (stack.length) {
      const cur = stack.pop()
      const cx = cur % cols
      const cy = (cur - cx) / cols
      if (minX[cur] < bx1) bx1 = minX[cur]
      if (minY[cur] < by1) by1 = minY[cur]
      if (maxX[cur] > bx2) bx2 = maxX[cur]
      if (maxY[cur] > by2) by2 = maxY[cur]

      // Visit only real tiles. A large configured radius must not spend time
      // scanning billions of coordinates outside a small capture.
      const left = Math.max(0, cx - gapTiles)
      const right = Math.min(cols - 1, cx + gapTiles)
      const top = Math.max(0, cy - gapTiles)
      const bottom = Math.min(rows - 1, cy + gapTiles)
      for (let ny = top; ny <= bottom; ny++) {
        for (let nx = left; nx <= right; nx++) {
          const n = ny * cols + nx
          if (!hit[n] || seen[n]) continue
          seen[n] = 1
          stack.push(n)
        }
      }
    }

    boxes.push({ x: bx1, y: by1, width: bx2 - bx1 + 1, height: by2 - by1 + 1 })
  }

  return boxes
}
