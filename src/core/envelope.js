/**
 * Compact binary envelope used by the HTTP transport for baselines.
 *
 * Layout:
 *   4 bytes  metadata length (unsigned, big endian)
 *   N bytes  UTF-8 JSON metadata
 *   rest     PNG bytes
 *
 * Keeping the image binary avoids base64's size penalty while still making a
 * baseline a single request and therefore a single ArtifactStore operation.
 */

const HEADER_BYTES = 4
const MAX_METADATA_BYTES = 1024 * 1024

export async function encodeBaselineEnvelope ({ image, meta }) {
  const metadata = new TextEncoder().encode(JSON.stringify(meta ?? {}))
  if (metadata.byteLength > MAX_METADATA_BYTES) {
    throw new RangeError('SnapEye baseline metadata is too large')
  }

  const imageBytes = await toUint8Array(image)
  const output = new Uint8Array(HEADER_BYTES + metadata.byteLength + imageBytes.byteLength)
  new DataView(output.buffer).setUint32(0, metadata.byteLength, false)
  output.set(metadata, HEADER_BYTES)
  output.set(imageBytes, HEADER_BYTES + metadata.byteLength)
  return output
}

export function decodeBaselineEnvelope (input) {
  const bytes = asUint8Array(input)
  if (bytes.byteLength < HEADER_BYTES) throw invalidEnvelope()

  const metadataLength = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    HEADER_BYTES
  ).getUint32(0, false)

  if (metadataLength > MAX_METADATA_BYTES || HEADER_BYTES + metadataLength > bytes.byteLength) {
    throw invalidEnvelope()
  }

  let meta
  try {
    const metadata = bytes.subarray(HEADER_BYTES, HEADER_BYTES + metadataLength)
    meta = JSON.parse(new TextDecoder().decode(metadata))
  } catch {
    throw invalidEnvelope()
  }

  return {
    meta,
    image: bytes.subarray(HEADER_BYTES + metadataLength)
  }
}

async function toUint8Array (data) {
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer())
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return asUint8Array(data)
}

function asUint8Array (data) {
  if (data instanceof Uint8Array) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  throw new TypeError('SnapEye baseline image must be a Blob, Uint8Array or ArrayBuffer')
}

function invalidEnvelope () {
  const error = new Error('Invalid SnapEye baseline envelope')
  error.code = 'INVALID_BASELINE_ENVELOPE'
  return error
}

