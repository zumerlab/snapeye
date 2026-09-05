import { describe, expect, it, vi } from 'vitest'
import { diffPixels } from '@zumer/snapdiff/diff'
import { attachSnapEye } from '../../src/client/runtime.js'
import { generateRunId, isValidRunId } from '../../src/core/ids.js'

const FIXED_DATE = Date.UTC(2026, 0, 2, 3, 4, 5)

describe('in-page SnapEye runtime', () => {
  it('waits for hydration before resolving a target that does not exist yet', async () => {
    let ready = false
    const harness = createRuntime({
      waitForReady: vi.fn(async () => { ready = true })
    })
    harness.document.querySelector.mockImplementation(selector =>
      ready && selector === '#target' ? harness.element : null)

    const result = await harness.api.capture('hydrated', '#target', {
      runId: 'hydrated_target',
      waitFor: '#target'
    })

    expect(result.status).toBe('ok')
    expect(harness.snapdom).toHaveBeenCalledWith(harness.element, expect.any(Object))
  })

  it('captures the replacement node when readiness hydrates an existing target', async () => {
    const replacement = createElement('target')
    let current
    const harness = createRuntime({
      waitForReady: vi.fn(async () => { current = replacement })
    })
    current = harness.element
    harness.document.querySelector.mockImplementation(() => current)

    const result = await harness.api.capture('hydrated', '#target', {
      runId: 'replaced_target',
      waitFor: '#ready'
    })

    expect(result.status).toBe('ok')
    expect(harness.snapdom).toHaveBeenCalledWith(replacement, expect.any(Object))
  })

  it('publishes a readiness error even before a target has been resolved', async () => {
    const harness = createRuntime({
      waitForReady: async () => { throw new Error('Readiness failed') }
    })

    const result = await harness.api.capture('hydrated', '#target', { runId: 'readiness_error' })

    expect(result).toMatchObject({ status: 'error', error: { code: 'CAPTURE_FAILED' } })
    expect(harness.store.commitResult).toHaveBeenCalledWith('readiness_error', result)
    expect(harness.snapdom).not.toHaveBeenCalled()
  })

  it('auto-generates a run id for the JavaScript API and persists the same id terminally', async () => {
    const random = () => 0
    const harness = createRuntime({ random })

    const result = await harness.api.capture('dashboard')

    expect(result.status).toBe('ok')
    expect(result.runId).toBe(generateRunId(FIXED_DATE, random))
    expect(isValidRunId(result.runId)).toBe(true)
    expect(harness.store.commitResult).toHaveBeenCalledOnce()
    expect(harness.store.commitResult).toHaveBeenCalledWith(result.runId, result)
  })

  it('logs missing and invalid URL run ids without reading or writing the store', async () => {
    const harness = createRuntime()

    await expect(harness.api.runUrlTrigger(
      'http://app.test/?__snapeye=capture&name=dashboard'
    )).resolves.toBeNull()
    await expect(harness.api.runUrlTrigger(
      'http://app.test/?__snapeye=capture&name=dashboard&run=..%2Foutside'
    )).resolves.toBeNull()

    expect(harness.window.console.error).toHaveBeenCalledTimes(2)
    for (const call of harness.window.console.error.mock.calls) {
      expect(call[0]).toBe('[snapeye]')
      expect(call[1]).toMatchObject({ code: 'INVALID_RUN_ID' })
    }
    expect(harness.store.readBaseline).not.toHaveBeenCalled()
    expect(harness.store.writeBaseline).not.toHaveBeenCalled()
    expect(harness.store.writeRunArtifact).not.toHaveBeenCalled()
    expect(harness.store.commitResult).not.toHaveBeenCalled()
    expect(harness.snapdom).not.toHaveBeenCalled()
  })

  it('publishes INVALID_OPERATION when the URL operation parameter is present but empty', async () => {
    const harness = createRuntime()

    const result = await harness.api.runUrlTrigger(
      'http://app.test/?__snapeye=&name=dashboard&run=empty_operation'
    )

    expect(result).toMatchObject({
      runId: 'empty_operation',
      status: 'error',
      operation: 'unknown',
      error: { code: 'INVALID_OPERATION' }
    })
    expect(harness.store.commitResult).toHaveBeenCalledWith('empty_operation', result)
    expect(harness.snapdom).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'invalid name',
      href: 'http://app.test/?__snapeye=capture&name=bad..name&run=name_error&target=%23target',
      code: 'INVALID_NAME'
    },
    {
      label: 'missing target',
      href: 'http://app.test/?__snapeye=capture&name=dashboard&run=target_error&target=%23missing',
      code: 'TARGET_NOT_FOUND'
    }
  ])('publishes a terminal error for a valid run with an $label', async ({ href, code }) => {
    const harness = createRuntime()

    const result = await harness.api.runUrlTrigger(href)

    expect(result).toMatchObject({
      status: 'error',
      operation: 'capture',
      error: { code }
    })
    expect(harness.store.commitResult).toHaveBeenCalledOnce()
    expect(harness.store.commitResult).toHaveBeenCalledWith(result.runId, result)
    expect(harness.store.writeBaseline).not.toHaveBeenCalled()
    expect(harness.store.writeRunArtifact).not.toHaveBeenCalled()
    expect(harness.snapdom).not.toHaveBeenCalled()
  })

  it('does not resolve the API promise until artifacts and then the terminal result persist', async () => {
    const artifact = deferred()
    const terminal = deferred()
    const events = []
    const store = createStore({
      writeBaseline: vi.fn(() => {
        events.push('artifact-start')
        return artifact.promise
      }),
      commitResult: vi.fn(() => {
        events.push('terminal-start')
        return terminal.promise
      })
    })
    const harness = createRuntime({ store })
    let settled = false

    const pending = harness.api.capture('dashboard', { runId: 'ordered_run' })
    pending.then(() => { settled = true })
    await vi.waitFor(() => expect(store.writeBaseline).toHaveBeenCalledOnce())

    expect(events).toEqual(['artifact-start'])
    expect(store.commitResult).not.toHaveBeenCalled()
    expect(settled).toBe(false)

    artifact.resolve()
    await vi.waitFor(() => expect(store.commitResult).toHaveBeenCalledOnce())

    expect(events).toEqual(['artifact-start', 'terminal-start'])
    expect(settled).toBe(false)

    terminal.resolve()
    const result = await pending
    expect(result.status).toBe('ok')
    expect(settled).toBe(true)
  })

  it('waits for every sibling artifact attempt before publishing a persistence error', async () => {
    let now = 0
    const lateArtifact = deferred()
    const store = createStore({
      writeRunArtifact: vi.fn(async (runId, filename) => {
        if (filename === 'frames.png') throw new Error('first upload failed')
        if (filename === 'recording.gif') return lateArtifact.promise
      })
    })
    const harness = createRuntime({
      store,
      now: () => now,
      wait: async milliseconds => { now += milliseconds },
      encodeGif: vi.fn(async () => new Blob(['gif'], { type: 'image/gif' }))
    })

    const pending = harness.api.record('motion', harness.element, {
      runId: 'settled_artifacts',
      duration: 100,
      fps: 1,
      format: 'gif'
    })
    await vi.waitFor(() => expect(store.writeRunArtifact).toHaveBeenCalledTimes(2))

    expect(store.commitResult).not.toHaveBeenCalled()
    lateArtifact.resolve()
    const result = await pending

    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'PERSIST_FAILED' }
    })
    expect(store.commitResult).toHaveBeenCalledWith('settled_artifacts', result)
  })

  it('keeps snap as the capture alias', async () => {
    const harness = createRuntime()

    expect(harness.api.snap).toBe(harness.api.capture)
    const result = await harness.api.snap('legacy', harness.element, { runId: 'snap_alias' })

    expect(result).toMatchObject({
      runId: 'snap_alias',
      status: 'ok',
      operation: 'capture',
      name: 'legacy'
    })
    expect(harness.store.writeBaseline).toHaveBeenCalledOnce()
  })

  it('uses SnapDOM viewBox geometry for transformed capture coordinates', async () => {
    const canvas = createCanvas(372, 320, 'rotated')
    const snapdom = vi.fn(async () => ({
      meta: {
        w0: 320,
        h0: 180,
        vbW: 372,
        vbH: 320,
        contentX: 25.564,
        contentY: 69.942,
        clip: null
      },
      toCanvas: async () => canvas
    }))
    const harness = createRuntime({ snapdom })

    const result = await harness.api.capture('rotated', harness.element, {
      runId: 'rotated_geometry'
    })

    expect(result).toMatchObject({
      status: 'ok',
      target: { selector: '#target' },
      image: {
        coordinateSpace: 'target-css-px',
        cssWidth: 372,
        cssHeight: 320,
        pixelWidth: 372,
        pixelHeight: 320,
        scale: 1
      }
    })
  })

  it.each([0, 1])('extracts custom-color regions only when SnapDiff reports changes (%i pixels)', async changedPixels => {
    const diffCanvasOutput = createCanvas(20, 10, 'diff')
    const diffColor = changedPixels ? [10, 20, 30] : [128, 128, 128]
    const pixels = new Uint8ClampedArray(20 * 10 * 4)
    pixels.set([...diffColor, 255], 0)
    diffCanvasOutput.getContext('2d').getImageData.mockReturnValue({ data: pixels })
    const diffCanvas = vi.fn(() => ({
      diff: changedPixels,
      total: 200,
      ratio: 0.005,
      width: 20,
      height: 10,
      dimsMatch: true,
      canvas: diffCanvasOutput
    }))
    const store = createStore({
      readBaseline: vi.fn(async () => ({
        image: new Blob(['baseline'], { type: 'image/png' }),
        meta: {
          schemaVersion: 1,
          name: 'custom-color',
          target: { selector: '#target' },
          image: {
            coordinateSpace: 'target-css-px',
            cssWidth: 20,
            cssHeight: 10,
            pixelWidth: 20,
            pixelHeight: 10,
            scale: 1
          }
        }
      }))
    })
    const harness = createRuntime({ store, diffCanvas })
    harness.window.createImageBitmap = vi.fn(async () => ({
      width: 20,
      height: 10,
      close: vi.fn()
    }))

    const result = await harness.api.diff('custom-color', harness.element, {
      runId: 'custom_diff_color',
      diffOptions: { diffColor },
      regionOptions: {
        tileSize: 1,
        gapTiles: 0,
        minRegionCssSide: 0,
        minRegionCssArea: 0
      }
    })

    expect(result).toMatchObject({
      status: 'ok',
      diff: {
        changed: changedPixels > 0,
        regionCount: changedPixels,
        regions: changedPixels ? [{ x: 0, y: 0, width: 1, height: 1, aggregate: false }] : []
      }
    })
    expect(diffCanvas.mock.calls[0][2]).toMatchObject({ diffColor })
    expect(diffCanvas).toHaveBeenCalledOnce()
    expect(diffCanvasOutput.getContext('2d').getImageData).toHaveBeenCalledTimes(changedPixels)
  })

  it.each([
    { label: 'grey wash', diffOptions: { diffColor: [230, 230, 230] }, comparisons: 2 },
    { label: 'default AA colour', diffOptions: { diffColor: [255, 255, 0] }, comparisons: 2 },
    { label: 'custom AA colour', diffOptions: { diffColor: [0, 255, 0], aaColor: [0, 255, 0] }, comparisons: 2 },
    { label: 'existing mask', diffOptions: { diffColor: [0, 0, 0], diffMask: true }, comparisons: 1 }
  ])('keeps real regions separate from $label pixels', async ({ diffOptions, comparisons }) => {
    // A black/white edge shifts by one anti-aliased column; those ten pixels
    // must remain excluded. The only real change is a separate 2x2 square.
    const baseline = new Uint8ClampedArray(20 * 10 * 4)
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 20; x++) {
        baseline.set(x >= 10 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * 20 + x) * 4)
      }
    }
    const current = baseline.slice()
    for (let y = 0; y < 10; y++) current.set([128, 128, 128, 255], (y * 20 + 9) * 4)
    for (let y = 4; y < 6; y++) {
      for (let x = 3; x < 5; x++) current.set([255, 255, 255, 255], (y * 20 + x) * 4)
    }
    const outputs = []
    const diffCanvas = vi.fn((before, after, options) => {
      const pixels = new Uint8ClampedArray(baseline.length)
      const stats = diffPixels(baseline, current, pixels, 20, 10, options)
      const canvas = createCanvas(20, 10, `comparison-${outputs.length}`)
      canvas.getContext('2d').getImageData.mockReturnValue({ data: pixels })
      outputs.push(canvas)
      return { ...stats, width: 20, height: 10, dimsMatch: true, canvas }
    })
    const store = createStore({
      readBaseline: vi.fn(async () => ({
        image: new Blob(['baseline'], { type: 'image/png' }),
        meta: {
          schemaVersion: 1,
          name: 'ambiguous-colour',
          image: {
            coordinateSpace: 'target-css-px',
            cssWidth: 20,
            cssHeight: 10,
            pixelWidth: 20,
            pixelHeight: 10,
            scale: 1
          }
        }
      }))
    })
    const harness = createRuntime({ store, diffCanvas, settle: false, stabilize: false })
    harness.window.createImageBitmap = async () => ({ width: 20, height: 10, close () {} })

    const result = await harness.api.diff('ambiguous-colour', '#target', {
      runId: 'ambiguous_colour',
      diffOptions,
      regionOptions: { tileSize: 1, gapTiles: 1, minRegionCssSide: 0, minRegionCssArea: 0 }
    })

    expect(result).toMatchObject({
      status: 'ok',
      diff: {
        changed: true,
        changedRatio: 0.02,
        regionCount: 1,
        regions: [{ x: 3, y: 4, width: 2, height: 2, aggregate: false }]
      }
    })
    expect(diffCanvas).toHaveBeenCalledTimes(comparisons)
    expect(harness.snapdom).toHaveBeenCalledOnce()
    expect(outputs[0].convertToBlob).toHaveBeenCalledOnce()
    if (comparisons === 2) {
      expect(diffCanvas.mock.calls[1][2]).toMatchObject({ ...diffOptions, diffMask: true })
      expect(outputs[1].convertToBlob).not.toHaveBeenCalled()
    }
    const diffArtifact = store.writeRunArtifact.mock.calls.find(([, filename]) => filename === 'diff.png')[2]
    expect(await diffArtifact.text()).toBe('comparison-0')
  })

  it('feeds one captured frame sequence to GIF, video, and filmstrip without recapturing', async () => {
    let now = 0
    const encodeGif = vi.fn(async () => new Blob(['gif'], { type: 'image/gif' }))
    const encodeVideo = vi.fn(async () => ({
      blob: new Blob(['video'], { type: 'video/webm' }),
      filename: 'recording.webm',
      mimeType: 'video/webm'
    }))
    const filmstripCanvas = createCanvas(60, 20, 'filmstrip')
    const createFilmstrip = vi.fn((frames, timestampsMs) => ({
      canvas: filmstripCanvas,
      meta: {
        file: 'frames.png',
        columns: frames.length,
        rows: 1,
        cells: timestampsMs.map((timestampMs, frameIndex) => ({ frameIndex, timestampMs }))
      }
    }))
    const harness = createRuntime({
      now: () => now,
      wait: async milliseconds => { now += milliseconds },
      encodeGif,
      encodeVideo,
      createFilmstrip
    })

    const result = await harness.api.record('motion', harness.element, {
      runId: 'shared_frames',
      duration: 300,
      fps: 10,
      format: 'both'
    })

    expect(result).toMatchObject({
      status: 'ok',
      operation: 'record',
      record: {
        durationRequestedMs: 300,
        durationActualMs: 300,
        fpsRequested: 10,
        frameCount: 3,
        timestampsMs: [0, 100, 200],
        format: 'both'
      },
      artifacts: {
        frames: 'frames.png',
        gif: 'recording.gif',
        video: 'recording.webm'
      }
    })

    const [filmstripFrames, filmstripTimestamps] = createFilmstrip.mock.calls[0]
    const [gifFrames, gifTimestamps] = encodeGif.mock.calls[0]
    const [videoFrames, videoTimestamps] = encodeVideo.mock.calls[0]
    expect(gifFrames).toBe(filmstripFrames)
    expect(videoFrames).toBe(filmstripFrames)
    expect(gifTimestamps).toBe(filmstripTimestamps)
    expect(videoTimestamps).toBe(filmstripTimestamps)
    expect(filmstripFrames).toEqual(harness.capturedCanvases)
    expect(harness.snapdom).toHaveBeenCalledTimes(result.record.frameCount)
    harness.capturedCanvases.forEach(canvas => {
      expect(canvas.convertToBlob).not.toHaveBeenCalled()
    })
    expect(filmstripCanvas.convertToBlob).toHaveBeenCalledOnce()

    const filenames = harness.store.writeRunArtifact.mock.calls.map(([, filename]) => filename)
    expect(filenames).toEqual(['frames.png', 'recording.gif', 'recording.webm'])
    const lastArtifactCall = Math.max(...harness.store.writeRunArtifact.mock.invocationCallOrder)
    expect(harness.store.commitResult.mock.invocationCallOrder[0]).toBeGreaterThan(lastArtifactCall)
  })

  it('owns recording raster dimensions so SnapDOM options cannot bypass the memory budget', async () => {
    let now = 0
    const harness = createRuntime({
      now: () => now,
      wait: async milliseconds => { now += milliseconds },
      encodeGif: vi.fn(async () => new Blob(['gif'], { type: 'image/gif' }))
    })

    const result = await harness.api.record('bounded', harness.element, {
      runId: 'bounded_options',
      duration: 100,
      fps: 1,
      format: 'gif',
      scale: 0.5,
      snapdomOptions: {
        dpr: 20,
        width: 100000,
        height: 100000,
        outerShadows: true
      }
    })

    expect(result.status).toBe('ok')
    expect(harness.snapdom).toHaveBeenCalledOnce()
    expect(harness.snapdom.mock.calls[0][1]).toMatchObject({
      dpr: 1,
      scale: 0.5,
      outerShadows: false,
      burst: false
    })
    expect(harness.snapdom.mock.calls[0][1]).not.toHaveProperty('width')
    expect(harness.snapdom.mock.calls[0][1]).not.toHaveProperty('height')
  })
  it('publishes BASELINE_NOT_FOUND instead of comparing against nothing', async () => {
    const harness = createRuntime()

    const result = await harness.api.diff('dashboard', '#target', { runId: 'diff_missing' })

    expect(result).toMatchObject({
      runId: 'diff_missing',
      status: 'error',
      operation: 'diff',
      name: 'dashboard',
      error: { code: 'BASELINE_NOT_FOUND', message: 'No baseline exists for dashboard' }
    })
    expect(result).not.toHaveProperty('diff')
    expect(harness.store.readBaseline).toHaveBeenCalledWith('dashboard')
    expect(harness.snapdom).not.toHaveBeenCalled()
    expect(harness.store.writeRunArtifact).not.toHaveBeenCalled()
    expect(harness.store.commitResult).toHaveBeenCalledWith('diff_missing', result)
  })

  it('rejects a baseline whose metadata does not describe this name', async () => {
    const store = createStore({
      readBaseline: vi.fn(async () => ({
        name: 'dashboard',
        meta: { schemaVersion: 1, name: 'something-else' },
        image: new Blob(['png'], { type: 'image/png' })
      }))
    })
    const harness = createRuntime({ store })

    const result = await harness.api.diff('dashboard', '#target', { runId: 'diff_meta' })

    expect(result).toMatchObject({
      status: 'error',
      operation: 'diff',
      error: { code: 'BASELINE_INCOMPATIBLE' }
    })
    expect(harness.snapdom).not.toHaveBeenCalled()
    expect(harness.store.writeRunArtifact).not.toHaveBeenCalled()
  })

  it('refuses to compare a baseline captured at a different size or scale', async () => {
    const store = createStore({
      readBaseline: vi.fn(async () => ({
        name: 'dashboard',
        meta: {
          schemaVersion: 1,
          name: 'dashboard',
          image: {
            coordinateSpace: 'target-css-px',
            cssWidth: 20,
            cssHeight: 10,
            pixelWidth: 40,
            pixelHeight: 20,
            scale: 2
          }
        },
        image: new Blob(['png'], { type: 'image/png' })
      }))
    })
    const harness = createRuntime({
      store,
      windowExtras: {
        createImageBitmap: vi.fn(async () => ({ width: 40, height: 20, close: vi.fn() }))
      }
    })

    const result = await harness.api.diff('dashboard', '#target', { runId: 'diff_scale' })

    expect(result).toMatchObject({
      status: 'error',
      operation: 'diff',
      error: { code: 'BASELINE_INCOMPATIBLE' }
    })
    // The mismatch is reported as data an agent can act on, never a stack.
    expect(result.error.details.baseline).toMatchObject({ pixelWidth: 40, scale: 2 })
    expect(result.error.details.current).toMatchObject({ pixelWidth: 20, scale: 1 })
    expect(harness.store.writeRunArtifact).not.toHaveBeenCalled()
  })

  it('never captures from a keystroke aimed at an editable element or a modifier combination', async () => {
    const harness = createRuntime({ hotkey: 'S' })
    const keydown = keydownListener(harness)

    const ignored = [
      keyEvent({ target: { tagName: 'INPUT' } }),
      keyEvent({ target: { tagName: 'TEXTAREA' } }),
      keyEvent({ target: { tagName: 'SELECT' } }),
      keyEvent({ target: { tagName: 'DIV', isContentEditable: true } }),
      keyEvent({ ctrlKey: true }),
      keyEvent({ metaKey: true }),
      keyEvent({ shiftKey: false })
    ]
    ignored.forEach(keydown)
    await Promise.resolve()

    for (const event of ignored) expect(event.preventDefault).not.toHaveBeenCalled()
    expect(harness.store.writeBaseline).not.toHaveBeenCalled()
    expect(harness.store.commitResult).not.toHaveBeenCalled()
  })

  it('captures under the configured hotkey name when the page itself is focused', async () => {
    const harness = createRuntime({ hotkey: 'S', hotkeyName: 'scratch' })
    const keydown = keydownListener(harness)

    const event = keyEvent({ target: { tagName: 'BODY' } })
    keydown(event)

    await vi.waitFor(() => expect(harness.store.commitResult).toHaveBeenCalled())
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(harness.store.writeBaseline).toHaveBeenCalledWith('scratch', expect.anything())
    expect(harness.store.commitResult.mock.calls[0][1]).toMatchObject({
      status: 'ok',
      operation: 'capture',
      name: 'scratch'
    })
  })
  it('pins motion for capture and diff, and never for record', async () => {
    const restoreMotion = vi.fn()
    const freezeMotion = vi.fn(async () => restoreMotion)
    const harness = createRuntime({ freezeMotion })

    await harness.api.capture('dashboard', '#target', { runId: 'freeze_capture' })
    expect(freezeMotion).toHaveBeenCalledOnce()
    expect(restoreMotion).toHaveBeenCalledOnce()

    await harness.api.record('motion', '#target', { runId: 'freeze_record', duration: 100, fps: 1 })
    // Motion is the subject of a recording; freezing it would capture nothing.
    expect(freezeMotion).toHaveBeenCalledOnce()
  })

  it('restores motion even when the operation fails', async () => {
    const restoreMotion = vi.fn()
    const snapdom = vi.fn(async () => { throw new Error('snapdom exploded') })
    const harness = createRuntime({ snapdom, freezeMotion: async () => restoreMotion })

    const result = await harness.api.capture('dashboard', '#target', { runId: 'freeze_failure' })

    expect(result).toMatchObject({ status: 'error', error: { code: 'CAPTURE_FAILED' } })
    expect(restoreMotion).toHaveBeenCalledOnce()
  })

  it('honours an opt-out and the URL wait parameter', async () => {
    const freezeMotion = vi.fn(async () => () => {})
    const waitForReady = vi.fn(async () => {})
    const harness = createRuntime({ freezeMotion, waitForReady })

    await harness.api.runUrlTrigger(
      'http://app.test/?__snapeye=capture&name=dashboard&run=wait_opts&target=%23target&wait=250&stabilize=0'
    )

    expect(freezeMotion).not.toHaveBeenCalled()
    expect(waitForReady).toHaveBeenCalledWith('250', expect.objectContaining({ document: harness.document }))
  })

})

function keydownListener (harness) {
  const call = harness.document.addEventListener.mock.calls.find(([type]) => type === 'keydown')
  expect(call, 'the runtime registered no keydown listener').toBeDefined()
  return call[1]
}

function keyEvent (overrides = {}) {
  return {
    key: 's',
    shiftKey: true,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: { tagName: 'BODY' },
    preventDefault: vi.fn(),
    ...overrides
  }
}

function createRuntime (overrides = {}) {
  const element = createElement('target')
  const capturedCanvases = []
  const document = {
    documentElement: element,
    body: { appendChild: vi.fn() },
    readyState: 'complete',
    querySelector: vi.fn(selector => selector === '#target' ? element : null),
    querySelectorAll: vi.fn(() => []),
    createElement: vi.fn(tag => tag === 'canvas' ? createCanvas() : createElement('', tag)),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }
  const window = {
    document,
    location: { href: 'http://app.test/' },
    performance: { now: () => 0 },
    console: {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn()
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout: (callback, delay) => setTimeout(callback, delay)
  }
  Object.assign(window, overrides.windowExtras)
  const store = overrides.store || createStore()
  const snapdom = overrides.snapdom || vi.fn(async () => {
    const canvas = createCanvas(20, 10, `frame-${capturedCanvases.length}`)
    capturedCanvases.push(canvas)
    return {
      meta: { w0: 20, h0: 10 },
      toCanvas: async () => canvas
    }
  })

  const api = attachSnapEye({
    window,
    document,
    store,
    snapdom,
    autoOnQuery: false,
    forwardConsole: false,
    errorOverlay: false,
    hotkey: null,
    dateNow: () => FIXED_DATE,
    ...overrides
  })

  return { api, window, document, element, store, snapdom, capturedCanvases }
}

function createStore (overrides = {}) {
  return {
    readBaseline: vi.fn(async () => null),
    writeBaseline: vi.fn(async () => {}),
    writeRunArtifact: vi.fn(async () => {}),
    commitResult: vi.fn(async () => {}),
    log: vi.fn(async () => true),
    ...overrides
  }
}

function createElement (id = '', tagName = 'div') {
  return {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    id,
    classList: [],
    style: { display: '', cssText: '' },
    scrollWidth: 20,
    scrollHeight: 10,
    clientWidth: 20,
    clientHeight: 10,
    getBoundingClientRect: () => ({ width: 20, height: 10 }),
    appendChild: vi.fn(),
    remove: vi.fn(),
    setAttribute: vi.fn()
  }
}

function createCanvas (width = 20, height = 10, label = 'png') {
  const context = {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(width * height * 4) }))
  }
  return {
    width,
    height,
    getContext: vi.fn(() => context),
    convertToBlob: vi.fn(async () => new Blob([label], { type: 'image/png' }))
  }
}

function deferred () {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
