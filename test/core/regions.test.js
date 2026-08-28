import { describe, expect, it } from 'vitest'
import {
  boundingBox,
  extractRegions,
  maskFromDiffBuffer,
  rasterRectToCss
} from '../../src/core/regions.js'

function maskWithRects (width, height, rects) {
  const mask = new Uint8Array(width * height)
  for (const rect of rects) {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        mask[y * width + x] = 1
      }
    }
  }
  return mask
}

const exactRegions = {
  tileSize: 1,
  // Radius 1 joins directly adjacent changed pixels into their rectangle while
  // leaving the deliberately separated fixtures as independent regions.
  gapTiles: 1,
  minRegionCssSide: 0,
  minRegionCssArea: 0,
  maxRegions: 20
}

describe('raster region adaptation', () => {
  it('identifies only the configured diff color', () => {
    const rgba = new Uint8Array([
      255, 0, 0, 255,
      255, 255, 0, 255,
      10, 10, 10, 255,
      10, 20, 30, 255
    ])

    expect([...maskFromDiffBuffer(rgba)]).toEqual([1, 0, 0, 0])
    expect([...maskFromDiffBuffer(rgba, [10, 20, 30])]).toEqual([0, 0, 0, 1])
  })

  it('converts raster rectangles outward into target CSS pixels', () => {
    expect(rasterRectToCss({ x: 3, y: 5, width: 4, height: 6 }, 2)).toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4
    })
  })

  it('clusters separated changes and reports stable CSS regions', () => {
    const mask = maskWithRects(30, 12, [
      { x: 1, y: 2, width: 3, height: 4 },
      { x: 15, y: 5, width: 5, height: 3 }
    ])

    expect(extractRegions(mask, 30, 12, exactRegions)).toEqual({
      regionCount: 2,
      regionsTruncated: false,
      regions: [
        { x: 15, y: 5, width: 5, height: 3, aggregate: false },
        { x: 1, y: 2, width: 3, height: 4, aggregate: false }
      ]
    })
  })

  it('groups nearby tiles into a single actionable region', () => {
    const mask = maskWithRects(12, 6, [
      { x: 1, y: 1, width: 2, height: 2 },
      { x: 5, y: 1, width: 2, height: 2 }
    ])

    expect(extractRegions(mask, 12, 6, {
      ...exactRegions,
      gapTiles: 3
    })).toEqual({
      regionCount: 1,
      regionsTruncated: false,
      regions: [{ x: 1, y: 1, width: 6, height: 2, aggregate: false }]
    })
  })

  it('converts extracted raster regions using the effective scale', () => {
    const mask = maskWithRects(12, 12, [{ x: 4, y: 2, width: 4, height: 4 }])

    expect(extractRegions(mask, 12, 12, {
      ...exactRegions,
      scale: 2
    }).regions).toEqual([
      { x: 2, y: 1, width: 2, height: 2, aggregate: false }
    ])
  })

  it('drops regions below the configured noise floor', () => {
    const mask = maskWithRects(20, 20, [{ x: 4, y: 4, width: 2, height: 2 }])

    expect(extractRegions(mask, 20, 20, {
      tileSize: 1,
      gapTiles: 1,
      minRegionCssSide: 4,
      minRegionCssArea: 24,
      maxRegions: 12
    })).toEqual({
      regionCount: 0,
      regionsTruncated: false,
      regions: []
    })
  })

  it('collapses excessive regions to one aggregate bounding box', () => {
    const mask = maskWithRects(30, 8, [
      { x: 1, y: 1, width: 2, height: 2 },
      { x: 10, y: 1, width: 2, height: 2 },
      { x: 20, y: 1, width: 2, height: 2 }
    ])

    expect(extractRegions(mask, 30, 8, {
      ...exactRegions,
      maxRegions: 2
    })).toEqual({
      regionCount: 3,
      regionsTruncated: true,
      regions: [{ x: 1, y: 1, width: 21, height: 2, aggregate: true }]
    })
  })

  it('computes the smallest bounding box containing all regions', () => {
    expect(boundingBox([
      { x: 3, y: 4, width: 2, height: 3 },
      { x: 10, y: 2, width: 4, height: 8 }
    ])).toEqual({ x: 3, y: 2, width: 11, height: 8 })
    expect(boundingBox([])).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
})
