import { describe, expect, it, vi } from 'vitest'
import {
  createFilmstrip,
  encodeGifFrames,
  encodeVideoFrames
} from '../../src/client/encoders.js'

describe('client encoders', () => {
  it('encodes supplied canvases as a GIF without performing a new capture', async () => {
    const frames = [
      rgbaCanvas([255, 0, 0, 255, 0, 255, 0, 255]),
      rgbaCanvas([0, 0, 255, 255, 255, 255, 255, 255])
    ]

    const gif = await encodeGifFrames(frames, [0, 80], { fps: 10 })

    expect(gif.type).toBe('image/gif')
    expect(gif.size).toBeGreaterThan(6)
    const signature = new TextDecoder().decode(new Uint8Array(await gif.arrayBuffer()).slice(0, 6))
    expect(signature).toMatch(/^GIF8[79]a$/)
    for (const frame of frames) {
      expect(frame.getContext).toHaveBeenCalledWith('2d')
      expect(frame.context.getImageData).toHaveBeenCalledWith(0, 0, 2, 1)
    }
  })

  it('holds the final GIF frame until durationMs instead of using the FPS fallback', async () => {
    const frames = [
      rgbaCanvas([255, 0, 0, 255, 0, 255, 0, 255]),
      rgbaCanvas([0, 0, 255, 255, 255, 255, 255, 255])
    ]

    const gif = await encodeGifFrames(frames, [0, 40], {
      fps: 25,
      durationMs: 130
    })

    expect(await gifFrameDelaysMs(gif)).toEqual([40, 90])
  })

  it('creates a bounded filmstrip whose cells retain source frame timestamps', () => {
    const context = {
      fillRect: vi.fn(),
      drawImage: vi.fn()
    }
    const output = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context)
    }
    const document = { createElement: vi.fn(() => output) }
    const frames = Array.from({ length: 4 }, (_, index) => ({
      id: `frame-${index}`,
      width: 100,
      height: 50
    }))

    const filmstrip = createFilmstrip(frames, [0, 80, 210, 400], {
      document,
      maxCells: 3,
      maxColumns: 3,
      maxWidth: 330,
      gap: 2
    })

    expect(filmstrip.canvas).toBe(output)
    expect(filmstrip.meta).toMatchObject({
      file: 'frames.png',
      columns: 3,
      rows: 1,
      cells: [
        { cell: 0, frameIndex: 0, timestampMs: 0 },
        { cell: 1, frameIndex: 2, timestampMs: 210 },
        { cell: 2, frameIndex: 3, timestampMs: 400 }
      ]
    })
    expect(output.width).toBeLessThanOrEqual(330)
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, output.width, output.height)
    expect(context.drawImage.mock.calls.map(([frame]) => frame.id)).toEqual([
      'frame-0',
      'frame-2',
      'frame-3'
    ])
  })

  it('replays supplied frames into MediaRecorder and returns the selected video artifact', async () => {
    vi.useFakeTimers()
    try {
      const context = {
        clearRect: vi.fn(),
        drawImage: vi.fn()
      }
      const videoTrack = {
        requestFrame: vi.fn(),
        stop: vi.fn()
      }
      const stream = {
        getVideoTracks: vi.fn(() => [videoTrack]),
        getTracks: vi.fn(() => [videoTrack])
      }
      const stage = {
        width: 0,
        height: 0,
        getContext: vi.fn(() => context),
        captureStream: vi.fn(() => stream)
      }
      const document = { createElement: vi.fn(() => stage) }
      const frames = [
        { id: 'frame-0', width: 20, height: 10 },
        { id: 'frame-1', width: 20, height: 10 }
      ]
      const startedAt = Date.now()

      const pending = encodeVideoFrames(frames, [0, 25], {
        document,
        MediaRecorder: FakeMediaRecorder,
        fps: 20,
        durationMs: 100
      })
      await vi.runAllTimersAsync()
      const encoded = await pending

      expect(encoded).toMatchObject({
        filename: 'recording.webm',
        mimeType: 'video/webm'
      })
      expect(encoded.blob.type).toBe('video/webm')
      expect(await encoded.blob.text()).toBe('encoded-video')
      expect(Date.now() - startedAt).toBe(100)
      expect(stage.captureStream).toHaveBeenCalledWith(20)
      expect(context.drawImage.mock.calls.map(([frame]) => frame.id)).toEqual([
        'frame-0',
        'frame-1'
      ])
      expect(videoTrack.requestFrame).toHaveBeenCalledTimes(2)
      expect(videoTrack.stop).toHaveBeenCalledOnce()
      expect(FakeMediaRecorder.instances.at(-1).options).toEqual({
        mimeType: 'video/webm;codecs=vp9'
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

function rgbaCanvas (pixels) {
  const context = {
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(pixels) }))
  }
  return {
    width: 2,
    height: 1,
    context,
    getContext: vi.fn(() => context)
  }
}

async function gifFrameDelaysMs (blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const delays = []
  for (let index = 0; index <= bytes.length - 8; index++) {
    const isGraphicControlExtension = bytes[index] === 0x21 &&
      bytes[index + 1] === 0xf9 &&
      bytes[index + 2] === 0x04
    if (!isGraphicControlExtension) continue
    const hundredths = bytes[index + 4] | (bytes[index + 5] << 8)
    delays.push(hundredths * 10)
    index += 7
  }
  return delays
}

class FakeMediaRecorder {
  static instances = []

  static isTypeSupported (type) {
    return type === 'video/webm;codecs=vp9'
  }

  constructor (stream, options) {
    this.stream = stream
    this.options = options
    this.mimeType = options.mimeType
    FakeMediaRecorder.instances.push(this)
  }

  start () {}

  stop () {
    this.ondataavailable?.({
      data: new Blob(['encoded-video'], { type: this.mimeType })
    })
    this.onstop?.()
  }
}
