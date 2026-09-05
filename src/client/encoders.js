import * as gifencNamespace from 'gifenc'
import {
  FILMSTRIP_DEFAULTS,
  ARTIFACTS
} from '../core/protocol.js'
import {
  selectKeyFrames,
  layoutFilmstrip,
  buildFilmstripMeta
} from '../core/filmstrip.js'

// gifenc ships CommonJS through `main`/`browser` and ESM through `module`, with
// no exports map, so every resolver hands it over differently: Node's namespace
// carries only `default`, while a bundler that picks the CommonJS build exposes
// named exports and NO default. A static `import x from 'gifenc'` therefore
// throws at evaluation time in the second case — taking the whole in-page
// client down with it — so the shape is chosen from a namespace import, which
// never fails.
const gifenc = typeof gifencNamespace.GIFEncoder === 'function'
  ? gifencNamespace
  : (gifencNamespace.default ?? gifencNamespace)
const GIFEncoder = gifenc.GIFEncoder || gifenc.default
const { quantize, applyPalette } = gifenc

/** Encode the already-captured shared frame sequence as GIF. */
export async function encodeGifFrames (frames, timestampsMs, options = {}) {
  if (!frames.length) throw new Error('Cannot encode a GIF without frames')
  const encoder = GIFEncoder()
  const fallbackDelay = Math.max(20, Math.round(1000 / (options.fps || 10)))

  for (let index = 0; index < frames.length; index++) {
    const canvas = frames[index]
    const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    const palette = quantize(rgba, options.maxColors || 256)
    const indexed = applyPalette(rgba, palette)
    const measuredDelay = frameDelay(timestampsMs, index, options.durationMs)
    encoder.writeFrame(indexed, canvas.width, canvas.height, {
      palette,
      delay: Number.isFinite(measuredDelay) && measuredDelay > 0 ? measuredDelay : fallbackDelay,
      repeat: options.repeat ?? 0
    })
  }

  encoder.finish()
  return new Blob([encoder.bytes()], { type: 'image/gif' })
}

/**
 * Encode the same shared canvases as browser-native video. No DOM capture is
 * performed here; frames are only replayed onto a MediaRecorder stage.
 */
export async function encodeVideoFrames (frames, timestampsMs, options = {}) {
  if (!frames.length) throw new Error('Cannot encode a video without frames')
  const MediaRecorderImpl = options.MediaRecorder || globalThis.MediaRecorder
  if (typeof MediaRecorderImpl !== 'function') {
    throw new Error('MediaRecorder is not available in this browser')
  }

  const stage = createCanvas(frames[0].width, frames[0].height, options.document)
  if (typeof stage.captureStream !== 'function') {
    throw new Error('Canvas captureStream is not available in this browser')
  }

  const fps = options.fps || 10
  const mimeType = pickVideoMime(MediaRecorderImpl)
  const stream = stage.captureStream(fps)
  const recorderOptions = {}
  if (mimeType) recorderOptions.mimeType = mimeType
  if (options.bitrate) recorderOptions.videoBitsPerSecond = options.bitrate
  const chunks = []
  const fallbackDelay = Math.max(1, Math.round(1000 / fps))
  let recorder
  let stopRequested = false
  try {
    // Constructor and context failures must release the capture stream too.
    recorder = new MediaRecorderImpl(stream, recorderOptions)
    const stopped = new Promise((resolve, reject) => {
      recorder.onstop = resolve
      recorder.onerror = event => reject(event.error || new Error('MediaRecorder failed'))
    })
    // A recorder can fail during start/draw, before the first awaited frame.
    // Attach a handler immediately; the awaited promise still propagates it.
    stopped.catch(() => {})
    recorder.ondataavailable = event => {
      if (event.data?.size) chunks.push(event.data)
    }
    const context = stage.getContext('2d')
    const track = stream.getVideoTracks?.()[0]
    recorder.start()
    for (let index = 0; index < frames.length; index++) {
      context.clearRect(0, 0, stage.width, stage.height)
      context.drawImage(frames[index], 0, 0, stage.width, stage.height)
      if (typeof track?.requestFrame === 'function') track.requestFrame()
      const measuredDelay = frameDelay(timestampsMs, index, options.durationMs)
      await Promise.race([
        wait(Number.isFinite(measuredDelay) && measuredDelay > 0 ? measuredDelay : fallbackDelay),
        stopped
      ])
    }
    recorder.stop()
    stopRequested = true
    await stopped
  } finally {
    if (recorder && !stopRequested) {
      try { recorder.stop() } catch {}
    }
    stream.getTracks?.().forEach(track => track.stop())
  }

  const outputType = (recorder.mimeType || mimeType || 'video/webm').split(';')[0]
  const filename = outputType === 'video/mp4' ? ARTIFACTS.mp4 : ARTIFACTS.webm
  return {
    blob: new Blob(chunks, { type: outputType }),
    filename,
    mimeType: outputType
  }
}

/** Build the bounded contact sheet and its exact cell/timestamp mapping. */
export function createFilmstrip (frames, timestampsMs, options = {}) {
  if (!frames.length) throw new Error('Cannot create a filmstrip without frames')
  const indices = selectKeyFrames(timestampsMs, options.maxCells || FILMSTRIP_DEFAULTS.maxCells)
  const layout = layoutFilmstrip({
    count: indices.length,
    frameWidth: frames[0].width,
    frameHeight: frames[0].height,
    maxColumns: options.maxColumns || FILMSTRIP_DEFAULTS.maxColumns,
    maxWidth: options.maxWidth || FILMSTRIP_DEFAULTS.maxWidth,
    gap: options.gap ?? FILMSTRIP_DEFAULTS.gap
  })
  const canvas = createCanvas(layout.width, layout.height, options.document)
  const context = canvas.getContext('2d')
  context.fillStyle = options.background || FILMSTRIP_DEFAULTS.background
  context.fillRect(0, 0, canvas.width, canvas.height)
  indices.forEach((frameIndex, cellIndex) => {
    const cell = layout.cells[cellIndex]
    context.drawImage(
      frames[frameIndex],
      cell.x,
      cell.y,
      layout.cellWidth,
      layout.cellHeight
    )
  })

  return {
    canvas,
    meta: buildFilmstripMeta({
      indices,
      layout,
      timestampsMs,
      filename: ARTIFACTS.frames
    })
  }
}

function pickVideoMime (MediaRecorderImpl) {
  const candidates = [
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ]
  if (typeof MediaRecorderImpl.isTypeSupported !== 'function') return ''
  return candidates.find(type => MediaRecorderImpl.isTypeSupported(type)) || ''
}

function createCanvas (width, height, documentImpl = globalThis.document) {
  const canvas = documentImpl.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function wait (milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function frameDelay (timestampsMs, index, durationMs) {
  const next = timestampsMs[index + 1]
  if (Number.isFinite(next)) return next - timestampsMs[index]
  if (Number.isFinite(durationMs)) return durationMs - timestampsMs[index]
  return NaN
}
