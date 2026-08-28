import { describe, expect, it } from 'vitest'
import {
  buildFilmstripMeta,
  layoutFilmstrip,
  selectKeyFrames
} from '../../src/core/filmstrip.js'

describe('filmstrip keyframe selection', () => {
  it('handles empty, single-frame, and unbounded selections', () => {
    expect(selectKeyFrames([], 4)).toEqual([])
    expect(selectKeyFrames([0], 4)).toEqual([0])
    expect(selectKeyFrames([0, 10, 20], 10)).toEqual([0, 1, 2])
  })

  it('spreads frames over measured time while preserving both endpoints', () => {
    expect(selectKeyFrames([0, 10, 50, 90, 100], 3)).toEqual([0, 2, 4])
  })

  it('always includes the real last frame when timestamps repeat', () => {
    expect(selectKeyFrames([0, 100, 100], 2)).toEqual([0, 2])
    expect(selectKeyFrames([0, 0, 0, 0], 3)).toEqual([0, 1, 3])
  })
})

describe('filmstrip layout and metadata', () => {
  it('preserves aspect ratio without upscaling', () => {
    const layout = layoutFilmstrip({
      count: 10,
      frameWidth: 100,
      frameHeight: 50,
      maxColumns: 4,
      maxWidth: 1600,
      gap: 8
    })

    expect(layout).toMatchObject({
      columns: 4,
      rows: 3,
      cellWidth: 100,
      cellHeight: 50,
      width: 440,
      height: 182,
      gap: 8
    })
    expect(layout.cells).toHaveLength(10)
  })

  it('treats maxWidth as a hard limit even below the requested gaps', () => {
    const layout = layoutFilmstrip({
      count: 4,
      frameWidth: 100,
      frameHeight: 100,
      maxColumns: 4,
      maxWidth: 10,
      gap: 8
    })

    expect(layout.width).toBeLessThanOrEqual(10)
    expect(layout).toMatchObject({ columns: 4, cellWidth: 1, gap: 1, width: 9 })
  })

  it('reduces columns when one pixel per requested column cannot fit', () => {
    const layout = layoutFilmstrip({
      count: 4,
      frameWidth: 100,
      frameHeight: 50,
      maxColumns: 4,
      maxWidth: 2,
      gap: 8
    })

    expect(layout).toMatchObject({ columns: 2, rows: 2, width: 2, gap: 0 })
  })

  it('maps every cell to its source frame and measured timestamp', () => {
    const layout = layoutFilmstrip({
      count: 3,
      frameWidth: 20,
      frameHeight: 10,
      maxColumns: 3,
      maxWidth: 100,
      gap: 2
    })
    const meta = buildFilmstripMeta({
      indices: [0, 2, 4],
      layout,
      timestampsMs: [0, 40, 101.4, 160, 220.8],
      filename: 'frames.png'
    })

    expect(meta).toMatchObject({
      file: 'frames.png',
      columns: 3,
      rows: 1,
      width: layout.width,
      height: layout.height
    })
    expect(meta.cells).toEqual([
      { cell: 0, frameIndex: 0, timestampMs: 0, ...layout.cells[0] },
      { cell: 1, frameIndex: 2, timestampMs: 101, ...layout.cells[1] },
      { cell: 2, frameIndex: 4, timestampMs: 221, ...layout.cells[2] }
    ])
  })
})
