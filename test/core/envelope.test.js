import { describe, expect, it } from 'vitest'
import { decodeBaselineEnvelope, encodeBaselineEnvelope } from '../../src/core/envelope.js'

describe('baseline envelope', () => {
  it('round-trips Unicode metadata and Blob image bytes', async () => {
    const encoded = await encodeBaselineEnvelope({
      meta: { schemaVersion: 1, selector: '#menú' },
      image: new Blob([new Uint8Array([0, 1, 2, 255])], { type: 'image/png' })
    })
    const decoded = decodeBaselineEnvelope(encoded)

    expect(decoded.meta).toEqual({ schemaVersion: 1, selector: '#menú' })
    expect([...decoded.image]).toEqual([0, 1, 2, 255])
  })

  it('preserves Uint8Array byte offsets instead of leaking the backing buffer', async () => {
    const backing = new Uint8Array([99, 10, 20, 30, 88])
    const encoded = await encodeBaselineEnvelope({
      meta: {},
      image: backing.subarray(1, 4)
    })

    expect([...decodeBaselineEnvelope(encoded).image]).toEqual([10, 20, 30])
  })

  it('accepts ArrayBuffer input', async () => {
    const encoded = await encodeBaselineEnvelope({
      meta: { scale: 2 },
      image: new Uint8Array([4, 5, 6]).buffer
    })

    expect([...decodeBaselineEnvelope(encoded.buffer).image]).toEqual([4, 5, 6])
  })

  it.each([
    new Uint8Array([0, 0, 0]),
    new Uint8Array([0, 16, 0, 0]),
    new Uint8Array([0, 0, 0, 1, 255])
  ])('rejects malformed envelopes', input => {
    expect(() => decodeBaselineEnvelope(input)).toThrow(/Invalid SnapEye baseline envelope/)
    try {
      decodeBaselineEnvelope(input)
    } catch (error) {
      expect(error.code).toBe('INVALID_BASELINE_ENVELOPE')
    }
  })

  it('rejects oversized metadata and unsupported image values', async () => {
    await expect(encodeBaselineEnvelope({
      meta: { value: 'x'.repeat(1024 * 1024) },
      image: new Uint8Array()
    })).rejects.toThrow(/metadata is too large/)
    await expect(encodeBaselineEnvelope({ meta: {}, image: 'not-binary' }))
      .rejects.toThrow(/Blob, Uint8Array or ArrayBuffer/)
  })
})
