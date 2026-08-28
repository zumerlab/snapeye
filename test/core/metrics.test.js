import { describe, expect, it } from 'vitest'
import {
  buildImageMeta,
  clampRecordOptions,
  computeChangedRatio,
  computeDurationActual,
  computeFpsActual,
  computeScale
} from '../../src/core/metrics.js'
import { COORDINATE_SPACE, RECORD_LIMITS } from '../../src/core/protocol.js'

describe('image scale and metadata', () => {
  it('computes the effective raster-to-CSS scale', () => {
    expect(computeScale({
      cssWidth: 300,
      cssHeight: 200,
      pixelWidth: 600,
      pixelHeight: 400
    })).toBe(2)
    expect(computeScale({ cssWidth: 100, pixelWidth: 150 })).toBe(1.5)
    expect(computeScale({})).toBe(1)
  })

  it('allows normal integer raster rounding', () => {
    expect(() => computeScale({
      cssWidth: 333.3,
      cssHeight: 199.8,
      pixelWidth: 667,
      pixelHeight: 400
    })).not.toThrow()
  })

  it('rejects anisotropic dimensions that cannot share one scale', () => {
    expect(() => computeScale({
      cssWidth: 100,
      cssHeight: 100,
      pixelWidth: 200,
      pixelHeight: 300
    })).toThrow(/anisotropic raster scale/)

    try {
      computeScale({ cssWidth: 100, cssHeight: 100, pixelWidth: 200, pixelHeight: 300 })
    } catch (error) {
      expect(error.code).toBe('ANISOTROPIC_SCALE')
      expect(error.details).toEqual({ scaleX: 2, scaleY: 3 })
    }
  })

  it('builds image metadata in target-relative CSS coordinates', () => {
    expect(buildImageMeta({
      cssWidth: 600.126,
      cssHeight: 400.555,
      pixelWidth: 1200,
      pixelHeight: 801
    }, COORDINATE_SPACE)).toEqual({
      coordinateSpace: COORDINATE_SPACE,
      cssWidth: 600.13,
      cssHeight: 400.56,
      pixelWidth: 1200,
      pixelHeight: 801,
      scale: 1.9996
    })
  })
})

describe('diff and recording metrics', () => {
  it('defines changedRatio as a bounded fraction from zero to one', () => {
    expect(computeChangedRatio(31, 1000)).toBe(0.031)
    expect(computeChangedRatio(0, 100)).toBe(0)
    expect(computeChangedRatio(120, 100)).toBe(1)
    expect(computeChangedRatio(-1, 100)).toBe(0)
    expect(computeChangedRatio(10, 0)).toBe(0)
  })

  it('derives actual FPS and duration from measured timestamps', () => {
    const timestamps = [100, 225, 350, 600]

    expect(computeFpsActual(timestamps)).toBe(6)
    expect(computeDurationActual(timestamps)).toBe(500)
    expect(computeFpsActual([10])).toBe(0)
    expect(computeFpsActual([20, 20])).toBe(0)
  })

  it('clamps requested recording options to documented limits', () => {
    const options = clampRecordOptions({ duration: 50000, fps: 100, scale: 10 })

    expect(options).toMatchObject({
      durationRequestedMs: 50000,
      fpsRequested: 100,
      scaleRequested: 10,
      durationMs: RECORD_LIMITS.maxDurationMs,
      fps: RECORD_LIMITS.maxFps,
      scale: RECORD_LIMITS.maxScale,
      frameCount: RECORD_LIMITS.maxFrames,
      budgetLimited: false,
      estimatedTotalPixels: null,
      maxTotalPixels: RECORD_LIMITS.maxTotalPixels
    })
    expect(options.intervalMs).toBe(100)
    expect(options.captureFps).toBe(10)
  })

  it('spreads a 15s @ 30fps recording across the full duration when capped at 150 frames', () => {
    const options = clampRecordOptions({ duration: 15000, fps: 30, scale: 1 })

    expect(options).toMatchObject({
      durationMs: 15000,
      fps: 30,
      frameCount: RECORD_LIMITS.maxFrames,
      intervalMs: 100,
      captureFps: 10
    })
    expect(options.intervalMs * options.frameCount).toBe(options.durationMs)
  })

  it('spreads frames retained by the pixel budget across the full duration', () => {
    const options = clampRecordOptions(
      { duration: 10000, fps: 30, scale: RECORD_LIMITS.minScale },
      { width: 10000, height: 10000 }
    )

    expect(options).toMatchObject({
      durationMs: 10000,
      scale: RECORD_LIMITS.minScale,
      frameCount: 120,
      intervalMs: 83.333,
      captureFps: 12,
      budgetLimited: true,
      estimatedTotalPixels: RECORD_LIMITS.maxTotalPixels
    })
    expect(options.intervalMs * options.frameCount).toBeCloseTo(options.durationMs, 0)
  })

  it('uses the complete 100ms duration for a one-frame 1fps recording', () => {
    const options = clampRecordOptions({ duration: 100, fps: 1 })

    expect(options).toMatchObject({
      durationMs: 100,
      fps: 1,
      frameCount: 1,
      intervalMs: 100
    })
  })

  it('makes memory-budget reductions explicit', () => {
    const options = clampRecordOptions(
      { duration: 15000, fps: 30, scale: 2 },
      { width: 4000, height: 4000 }
    )

    expect(options.budgetLimited).toBe(true)
    expect(options.estimatedTotalPixels).toBeLessThanOrEqual(options.maxTotalPixels)
    expect(options.frameCount).toBeLessThanOrEqual(RECORD_LIMITS.maxFrames)
    expect(options.scale).toBeLessThan(2)
  })

  it('fails explicitly when one minimum-scale frame exceeds the budget', () => {
    expect(() => clampRecordOptions(
      { duration: 100, fps: 1, scale: RECORD_LIMITS.minScale },
      { width: 1_000_000, height: 1_000_000 }
    )).toThrow(/even one frame/)

    try {
      clampRecordOptions(
        { duration: 100, fps: 1, scale: RECORD_LIMITS.minScale },
        { width: 1_000_000, height: 1_000_000 }
      )
    } catch (error) {
      expect(error.code).toBe('RECORD_BUDGET_EXCEEDED')
      expect(error.details.maxTotalPixels).toBe(RECORD_LIMITS.maxTotalPixels)
    }
  })
})
