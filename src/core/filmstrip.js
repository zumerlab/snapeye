/**
 * Filmstrip geometry — which frames make the contact sheet and where each one
 * lands on it. Pure maths: the canvas work lives in the client engine, the
 * decisions live here so they can be tested without a browser.
 *
 * The filmstrip exists so a model can inspect a whole recording with a single
 * image read, and the metadata ties every cell back to its real timestamp.
 */
import { FILMSTRIP_DEFAULTS } from './protocol.js'

/**
 * Pick up to `maxCells` frames spread evenly over *time* (not over the frame
 * index, which would over-sample whichever stretch happened to run fast).
 * The first and last frames are always included.
 *
 * @param {number[]} timestampsMs monotonic, relative to frame 0
 * @param {number} [maxCells]
 * @returns {number[]} frame indices, ascending
 */
export function selectKeyFrames (timestampsMs, maxCells = FILMSTRIP_DEFAULTS.maxCells) {
  const n = Array.isArray(timestampsMs) ? timestampsMs.length : 0
  if (n === 0) return []
  const requestedCells = Number.isFinite(maxCells)
    ? Math.floor(maxCells)
    : FILMSTRIP_DEFAULTS.maxCells
  const cells = Math.max(1, Math.min(requestedCells, n))
  if (cells === 1) return [0]
  if (cells >= n) return timestampsMs.map((_, i) => i)

  const first = timestampsMs[0]
  const span = timestampsMs[n - 1] - first
  // Reserve both endpoints up front. Picking solely by timestamp can otherwise
  // choose the first member of a duplicate-timestamp group and omit the real
  // final frame, which is precisely the frame most useful for a recording.
  const picked = [0, n - 1]
  const seen = new Set(picked)

  for (let c = 1; c < cells - 1; c++) {
    const wantedIndex = ((n - 1) * c) / (cells - 1)
    const wanted = span > 0
      ? first + (span * c) / (cells - 1)
      : timestampsMs[Math.round(wantedIndex)]
    let best = -1
    let bestDelta = Infinity
    let bestIndexDelta = Infinity
    for (let i = 1; i < n - 1; i++) {
      if (seen.has(i)) continue
      const delta = Number.isFinite(timestampsMs[i]) && Number.isFinite(wanted)
        ? Math.abs(timestampsMs[i] - wanted)
        : Infinity
      const indexDelta = Math.abs(i - wantedIndex)
      if (delta < bestDelta || (delta === bestDelta && indexDelta < bestIndexDelta)) {
        bestDelta = delta
        bestIndexDelta = indexDelta
        best = i
      }
    }
    // Invalid timestamps should not make the selection short. The remaining
    // frame nearest the ideal index is still deterministic and representative.
    if (best < 0) {
      for (let i = 1; i < n - 1; i++) {
        if (seen.has(i)) continue
        const indexDelta = Math.abs(i - wantedIndex)
        if (indexDelta < bestIndexDelta) {
          bestIndexDelta = indexDelta
          best = i
        }
      }
    }
    seen.add(best)
    picked.push(best)
  }

  return picked.sort((a, b) => a - b)
}

/**
 * Lay the selected frames out on a grid that never exceeds `maxWidth` raster
 * pixels. Cells keep the source aspect ratio and are never upscaled.
 *
 * @returns {{columns:number, rows:number, cellWidth:number, cellHeight:number,
 *            width:number, height:number, gap:number, cells:Array<{x:number,y:number}>}}
 */
export function layoutFilmstrip ({
  count,
  frameWidth,
  frameHeight,
  maxColumns = FILMSTRIP_DEFAULTS.maxColumns,
  maxWidth = FILMSTRIP_DEFAULTS.maxWidth,
  gap = FILMSTRIP_DEFAULTS.gap
}) {
  const n = Math.max(0, Math.floor(finiteOr(count, 0)))
  const srcW = Math.max(1, Math.floor(finiteOr(frameWidth, 1)))
  const srcH = Math.max(1, Math.floor(finiteOr(frameHeight, 1)))
  const widthLimit = Math.max(1, Math.floor(Number(maxWidth) || 1))
  const requestedGap = Math.max(0, Math.floor(Number(gap) || 0))
  if (n === 0) {
    return { columns: 0, rows: 0, cellWidth: 0, cellHeight: 0, width: 0, height: 0, gap: requestedGap, cells: [] }
  }

  // At least one raster pixel is required per column. When the configured
  // width is unusually small, reduce columns first and then the gap; this
  // keeps the advertised `maxWidth` a hard ceiling rather than a suggestion.
  const requestedColumns = Math.max(1, Math.floor(Number(maxColumns) || 1))
  const columns = Math.max(1, Math.min(requestedColumns, n, widthLimit))
  const rows = Math.ceil(n / columns)
  const maxGap = Math.max(0, Math.floor((widthLimit - columns) / (columns + 1)))
  const effectiveGap = Math.min(requestedGap, maxGap)

  const available = widthLimit - effectiveGap * (columns + 1)
  const cellWidth = Math.max(1, Math.min(srcW, Math.floor(available / columns)))
  const cellHeight = Math.max(1, Math.round(srcH * (cellWidth / srcW)))

  const cells = []
  for (let i = 0; i < n; i++) {
    const col = i % columns
    const row = Math.floor(i / columns)
    cells.push({
      x: effectiveGap + col * (cellWidth + effectiveGap),
      y: effectiveGap + row * (cellHeight + effectiveGap)
    })
  }

  return {
    columns,
    rows,
    cellWidth,
    cellHeight,
    gap: effectiveGap,
    width: effectiveGap + columns * (cellWidth + effectiveGap),
    height: effectiveGap + rows * (cellHeight + effectiveGap),
    cells
  }
}

function finiteOr (value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

/**
 * The `filmstrip` block published in `result.json`: every cell carries the
 * frame it came from and the timestamp that frame was captured at, so a model
 * can say "the flicker happens at 1.2 s" from the contact sheet alone.
 */
export function buildFilmstripMeta ({ indices, layout, timestampsMs, filename }) {
  return {
    file: filename,
    columns: layout.columns,
    rows: layout.rows,
    cellWidth: layout.cellWidth,
    cellHeight: layout.cellHeight,
    gap: layout.gap,
    width: layout.width,
    height: layout.height,
    cells: indices.map((frameIndex, i) => ({
      cell: i,
      frameIndex,
      timestampMs: Math.round(timestampsMs[frameIndex] ?? 0),
      x: layout.cells[i]?.x ?? 0,
      y: layout.cells[i]?.y ?? 0
    }))
  }
}
