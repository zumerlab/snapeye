import { diffCanvas as snapDiffCanvas } from '@zumer/snapdiff/diff'
import {
  ARTIFACTS,
  COORDINATE_SPACE,
  DIFF_DEFAULTS,
  ERROR_CODES,
  OPERATIONS,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  TRIGGER_PARAM
} from '../core/protocol.js'
import { assertName, assertRunId, generateRunId, isValidRunId } from '../core/ids.js'
import { buildErrorResult, buildResult } from '../core/result.js'
import { buildImageMeta, clampRecordOptions, computeChangedRatio, computeFpsActual } from '../core/metrics.js'
import { extractRegions, maskFromDiffBuffer } from '../core/regions.js'
import { SnapEyeError, operationError, persistenceError } from '../core/errors.js'
import { createHttpArtifactStore } from './http-store.js'
import { createLegacyArtifactStore } from './legacy-store.js'
import { createFilmstrip, encodeGifFrames, encodeVideoFrames } from './encoders.js'
import { freezeMotion, waitForReady, waitForSettled } from './stability.js'

const RUNTIME_STATE = Symbol.for('@zumer/snapeye/runtime')
const KNOWN_OPERATIONS = new Set(OPERATIONS)

const DEFAULTS = {
  snapdom: null,
  store: null,
  endpoint: '/__snapeye',
  token: null,
  autoOnQuery: true,
  triggerDelay: 100,
  forwardConsole: true,
  errorOverlay: true,
  hotkey: 'S',
  /** Baseline replaced by the hotkey capture. */
  hotkeyName: 'current',
  hideSelectors: ['#__snapeye_err__'],
  /**
   * Pin animations and transitions before capture/diff so an unchanged page
   * cannot report a change. Never applies to `record`.
   */
  stabilize: true,
  /** Milliseconds, or a selector to wait for, before capturing. */
  waitFor: null,
  /**
   * Wait for the page to stop changing before capturing. A cold dev server
   * settles seconds after DOMContentLoaded; a fixed delay captures a page that
   * is still assembling itself.
   */
  settle: true,
  /** Ceiling for the settle wait. */
  settleTimeout: 2500,
  /** Ceiling for a selector `waitFor`. */
  waitTimeout: 5000,
  snapdomOptions: {
    format: 'png',
    dpr: 1,
    scale: 1,
    embedFonts: false
  },
  diffOptions: {
    threshold: DIFF_DEFAULTS.threshold,
    includeAA: false
  },
  filmstripOptions: {}
}

/** Attach the in-page runtime to a browser document. */
export function attachSnapEye (userOptions = {}) {
  const windowImpl = userOptions.window || globalThis.window
  const documentImpl = userOptions.document || windowImpl?.document || globalThis.document
  if (!windowImpl || !documentImpl) throw new Error('SnapEye must be attached in a browser document')

  if (userOptions.reuse !== false && windowImpl[RUNTIME_STATE]?.api) {
    return windowImpl[RUNTIME_STATE].api
  }

  const options = {
    ...DEFAULTS,
    ...userOptions,
    snapdomOptions: { ...DEFAULTS.snapdomOptions, ...userOptions.snapdomOptions },
    diffOptions: { ...DEFAULTS.diffOptions, ...userOptions.diffOptions },
    filmstripOptions: { ...DEFAULTS.filmstripOptions, ...userOptions.filmstripOptions }
  }
  if (typeof options.snapdom !== 'function') throw new Error('snapeye: pass the `snapdom` function')

  const configuredStore = options.store || options.artifactStore
  const legacy = options.legacy === true || (
    options.legacy !== false &&
    !configuredStore &&
    userOptions.endpoint == null &&
    userOptions.token == null
  )
  if (legacy) options.endpoint = '/__snapeye__'
  const store = configuredStore || (legacy
    ? createLegacyArtifactStore({
        endpoint: options.endpoint,
        fetch: options.fetch || windowImpl.fetch?.bind(windowImpl)
      })
    : createHttpArtifactStore({
        endpoint: options.endpoint,
        token: options.token,
        fetch: options.fetch || windowImpl.fetch?.bind(windowImpl)
      }))
  assertArtifactStore(store)

  const clock = {
    now: options.now || (() => windowImpl.performance.now()),
    dateNow: options.dateNow || Date.now,
    wait: options.wait || (ms => new Promise(resolve => windowImpl.setTimeout(resolve, ms)))
  }
  const dependencies = {
    diffCanvas: options.diffCanvas || snapDiffCanvas,
    waitForSettled: options.waitForSettled || waitForSettled,
    encodeGif: options.encodeGif || encodeGifFrames,
    encodeVideo: options.encodeVideo || encodeVideoFrames,
    createFilmstrip: options.createFilmstrip || createFilmstrip,
    freezeMotion: options.freezeMotion || freezeMotion,
    waitForReady: options.waitForReady || waitForReady
  }
  const originalConsole = {}
  let errorBox = null

  async function capture (name, target, callOptions) {
    const args = normalizeCall(target, callOptions)
    return execute('capture', name, args.target, args.options)
  }

  async function diff (name, target, callOptions) {
    const args = normalizeCall(target, callOptions)
    return execute('diff', name, args.target, args.options)
  }

  async function record (name, target, callOptions) {
    const args = normalizeCall(target, callOptions)
    return execute('record', name, args.target, args.options)
  }

  async function execute (operation, name, targetInput, operationOptions = {}) {
    const runId = operationOptions.runId || generateRunId(clock.dateNow(), options.random || Math.random)
    const startedAt = new Date(clock.dateNow()).toISOString()
    try {
      assertRunId(runId)
    } catch (error) {
      reportTechnical(error)
      throw error
    }

    let safeName
    try {
      safeName = assertName(name)
    } catch (error) {
      return commitError({ runId, operation, name, startedAt, error })
    }

    if (!KNOWN_OPERATIONS.has(operation)) {
      return commitError({
        runId,
        operation: 'unknown',
        name: safeName,
        startedAt,
        error: new SnapEyeError(ERROR_CODES.INVALID_OPERATION, `Unknown SnapEye operation: ${operation}`)
      })
    }

    if (legacy && operation !== 'capture') {
      return commitError({
        runId,
        operation,
        name: safeName,
        startedAt,
        error: new SnapEyeError(
          operation === 'diff' ? ERROR_CODES.DIFF_FAILED : ERROR_CODES.RECORD_FAILED,
          'The legacy SnapEye handler supports capture only; use the Vite plugin for V1 operations'
        )
      })
    }

    let resolved
    try {
      const payload = await withHiddenElements(async () => {
        await dependencies.waitForReady(operationOptions.waitFor ?? options.waitFor, {
          document: documentImpl,
          wait: clock.wait,
          now: clock.now,
          timeoutMs: operationOptions.waitTimeout ?? options.waitTimeout
        })
        // Hydration can create or replace the target while readiness is being
        // awaited. Resolve it afterwards so we capture the live element.
        resolved = resolveTarget(targetInput, operationOptions)
        if ((operationOptions.settle ?? options.settle) !== false) {
          await dependencies.waitForSettled({
            document: documentImpl,
            window: windowImpl,
            element: resolved.element,
            budgetMs: operationOptions.settleTimeout ?? options.settleTimeout,
            wait: clock.wait
          })
        }
        // Motion is the subject of a recording, so only capture and diff pin it.
        const stabilize = operation !== 'record' &&
          (operationOptions.stabilize ?? options.stabilize) !== false
        const restoreMotion = stabilize
          ? await dependencies.freezeMotion(documentImpl, { window: windowImpl, wait: clock.wait })
          : null
        try {
          if (operation === 'capture') return await performCapture(runId, safeName, resolved, operationOptions)
          if (operation === 'diff') return await performDiff(runId, safeName, resolved, operationOptions)
          return await performRecord(runId, safeName, resolved, operationOptions)
        } finally {
          restoreMotion?.()
        }
      })
      const result = buildResult({
        runId,
        status: 'ok',
        operation,
        name: safeName,
        target: resolved.meta,
        startedAt,
        finishedAt: new Date(clock.dateNow()).toISOString(),
        ...payload
      })
      try {
        await store.commitResult(runId, result)
      } catch (error) {
        reportTechnical(error)
        throw persistenceError(error)
      }
      return result
    } catch (error) {
      return commitError({ runId, operation, name: safeName, target: resolved?.meta, startedAt, error })
    }
  }

  async function commitError ({ runId, operation, name, target, startedAt, error }) {
    const normalized = operationError(error, operation)
    reportTechnical(error)
    const result = buildErrorResult({
      runId,
      operation: KNOWN_OPERATIONS.has(operation) ? operation : 'unknown',
      name,
      target,
      startedAt,
      finishedAt: new Date(clock.dateNow()).toISOString(),
      code: normalized.code,
      message: normalized.message,
      details: normalized.details
    })
    try {
      await store.commitResult(runId, result)
      return result
    } catch (commitFailure) {
      reportTechnical(commitFailure)
      throw persistenceError(commitFailure)
    }
  }

  async function performCapture (runId, name, target, operationOptions) {
    const captured = await captureTarget(target.element, operationOptions, true)
    const baselineMeta = {
      schemaVersion: SCHEMA_VERSION,
      name,
      capturedAt: new Date(clock.dateNow()).toISOString(),
      target: target.meta,
      image: captured.image
    }
    try {
      await store.writeBaseline(name, { image: captured.blob, meta: baselineMeta })
    } catch (error) {
      throw persistenceError(error)
    }
    return {
      image: captured.image,
      artifacts: { baseline: `../../baselines/${name}.png` }
    }
  }

  async function performDiff (runId, name, target, operationOptions) {
    let baseline
    try {
      baseline = await store.readBaseline(name)
    } catch (error) {
      throw persistenceError(error)
    }
    if (!baseline) throw new SnapEyeError(ERROR_CODES.BASELINE_NOT_FOUND, `No baseline exists for ${name}`)
    validateBaselineMetadata(baseline.meta, name)

    let baselineCanvas
    try {
      baselineCanvas = await blobToCanvas(baseline.image)
    } catch {
      throw new SnapEyeError(ERROR_CODES.BASELINE_INCOMPATIBLE, `Baseline ${name} is not a readable PNG`)
    }
    const captured = await captureTarget(target.element, operationOptions, true)
    assertBaselineCompatible(baseline.meta, baselineCanvas, captured.image)

    const diffOptions = {
      ...options.diffOptions,
      ...operationOptions.diffOptions
    }
    let comparison
    try {
      comparison = dependencies.diffCanvas(baselineCanvas, captured.canvas, diffOptions)
    } catch {
      throw new SnapEyeError(ERROR_CODES.DIFF_FAILED, 'SnapEye could not compare the current capture')
    }
    if (!comparison.dimsMatch) {
      throw new SnapEyeError(ERROR_CODES.BASELINE_INCOMPATIBLE, `Baseline ${name} has incompatible raster dimensions`)
    }

    const diffBlob = await canvasToPng(comparison.canvas)
    // SnapDiff's unchanged-pixel wash can match a custom diffColor. Its pixel
    // count is authoritative, and an unchanged capture needs no readback or
    // image-sized region mask.
    const changed = comparison.diff > 0
    let regionCanvas = comparison.canvas
    if (changed && needsRegionMask(diffOptions)) {
      // A grey diffColor can equal the unchanged-pixel wash, and matching
      // aaColor includes pixels SnapDiff deliberately excluded. Its mask
      // output omits both while the original canvas remains the artifact.
      try {
        regionCanvas = dependencies.diffCanvas(baselineCanvas, captured.canvas, {
          ...diffOptions,
          diffMask: true
        }).canvas
      } catch {
        throw new SnapEyeError(ERROR_CODES.DIFF_FAILED, 'SnapEye could not compare the current capture')
      }
    }
    const diffPixels = changed
      ? regionCanvas.getContext('2d').getImageData(0, 0, comparison.width, comparison.height).data
      : null
    const regions = extractRegions(
      changed ? maskFromDiffBuffer(diffPixels, diffOptions.diffColor) : new Uint8Array(0),
      changed ? comparison.width : 0,
      changed ? comparison.height : 0,
      { scale: captured.image.scale, ...operationOptions.regionOptions }
    )
    await persistRunArtifacts(runId, [
      { filename: ARTIFACTS.current, data: captured.blob },
      { filename: ARTIFACTS.diff, data: diffBlob }
    ])

    return {
      image: captured.image,
      diff: {
        changed,
        changedRatio: computeChangedRatio(comparison.diff, comparison.total),
        ...regions
      },
      artifacts: {
        baseline: `../../baselines/${name}.png`,
        current: ARTIFACTS.current,
        diff: ARTIFACTS.diff
      }
    }
  }

  async function performRecord (runId, name, target, operationOptions) {
    let plan
    try {
      plan = clampRecordOptions(operationOptions, readCssSize(target.element))
    } catch (error) {
      if (error?.code === 'RECORD_BUDGET_EXCEEDED') {
        throw new SnapEyeError(
          ERROR_CODES.RECORD_FAILED,
          'The target is too large for SnapEye recording limits',
          error.details
        )
      }
      throw error
    }
    const format = normalizeRecordFormat(operationOptions.format)
    const recordSnapdomOptions = {
      ...operationOptions.snapdomOptions,
      dpr: 1,
      outerShadows: false,
      // CSS animations and canvas draws do not necessarily produce DOM
      // mutations, so SnapDOM's burst cache is unsafe for a frame sequence.
      burst: false,
      width: undefined,
      height: undefined
    }
    // Arbitrary export dimensions bypass the frame-memory budget. Recording
    // owns its raster scale; callers can use the bounded top-level `scale`.
    const frames = []
    const timestampsMs = []
    let firstImage = null
    let firstWidth = 0
    let firstHeight = 0
    const started = clock.now()

    for (let frameIndex = 0; frameIndex < plan.frameCount; frameIndex++) {
      if (frameIndex > 0) {
        const delay = started + frameIndex * plan.intervalMs - clock.now()
        if (delay > 0) await clock.wait(delay)
        if (clock.now() - started >= plan.durationMs) break
      }
      const timestamp = clock.now() - started
      let captured
      try {
        captured = await captureTarget(target.element, {
          ...operationOptions,
          scale: plan.scale,
          snapdomOptions: recordSnapdomOptions
        }, false)
      } catch {
        throw new SnapEyeError(ERROR_CODES.RECORD_FAILED, 'SnapEye could not capture a recording frame')
      }
      if (!firstImage) {
        firstImage = captured.image
        firstWidth = captured.canvas.width
        firstHeight = captured.canvas.height
        const actualFramePixels = firstWidth * firstHeight
        const rasterBudgetFrames = Math.floor(plan.maxTotalPixels / actualFramePixels)
        if (rasterBudgetFrames < 1) {
          throw new SnapEyeError(
            ERROR_CODES.RECORD_FAILED,
            'The produced raster is too large for SnapEye recording limits',
            { actualFramePixels, maxTotalPixels: plan.maxTotalPixels }
          )
        }
        if (rasterBudgetFrames < plan.frameCount) {
          plan.frameCount = rasterBudgetFrames
          plan.intervalMs = plan.durationMs / plan.frameCount
          plan.captureFps = Math.round((1000 / plan.intervalMs) * 100) / 100
        }
      }
      frames.push(normalizeFrame(captured.canvas, firstWidth, firstHeight))
      timestampsMs.push(roundTimestamp(timestamp))
    }

    if (!frames.length) throw new SnapEyeError(ERROR_CODES.RECORD_FAILED, 'SnapEye did not capture any recording frames')
    // Keep the collection window faithful to the requested/clamped duration.
    // The last captured frame is held for the final interval by the encoders,
    // just like a sampled video stream; no second capture pass is performed.
    const remaining = plan.durationMs - (clock.now() - started)
    if (remaining > 0) await clock.wait(remaining)
    const durationActualMs = Math.max(0, Math.round(clock.now() - started))
    const filmstrip = dependencies.createFilmstrip(frames, timestampsMs, {
      ...options.filmstripOptions,
      ...operationOptions.filmstripOptions,
      document: documentImpl
    })
    const filmstripBlob = await canvasToPng(filmstrip.canvas)
    const artifacts = { frames: ARTIFACTS.frames }
    const encodedArtifacts = [{ filename: ARTIFACTS.frames, data: filmstripBlob }]

    if (format === 'gif' || format === 'both') {
      const gif = await dependencies.encodeGif(frames, timestampsMs, {
        fps: plan.captureFps,
        durationMs: durationActualMs
      })
      artifacts.gif = ARTIFACTS.gif
      encodedArtifacts.push({ filename: ARTIFACTS.gif, data: gif })
    }
    if (format === 'video' || format === 'both') {
      const video = await dependencies.encodeVideo(frames, timestampsMs, {
        fps: plan.captureFps,
        durationMs: durationActualMs,
        bitrate: operationOptions.bitrate,
        document: documentImpl
      })
      artifacts.video = video.filename
      encodedArtifacts.push({ filename: video.filename, data: video.blob })
    }
    await persistRunArtifacts(runId, encodedArtifacts)

    return {
      image: firstImage,
      record: {
        durationRequestedMs: plan.durationRequestedMs,
        durationActualMs,
        fpsRequested: plan.fpsRequested,
        fpsActual: computeFpsActual(timestampsMs),
        frameCount: frames.length,
        timestampsMs,
        format,
        filmstrip: filmstrip.meta
      },
      artifacts
    }
  }

  async function persistRunArtifacts (runId, artifacts) {
    const settled = await Promise.allSettled(artifacts.map(({ filename, data }) =>
      Promise.resolve().then(() => store.writeRunArtifact(runId, filename, data))))
    const failure = settled.find(result => result.status === 'rejected')
    if (failure) throw persistenceError(failure.reason)
  }

  async function captureTarget (element, operationOptions, includeBlob) {
    const fallbackCss = readCssSize(element)
    const captureOptions = { ...options.snapdomOptions, ...operationOptions.snapdomOptions }
    if (captureOptions.width == null) delete captureOptions.width
    if (captureOptions.height == null) delete captureOptions.height
    // CSSOM edits are invisible to DOM mutation observers. A visual comparison
    // must include them even when v3 can otherwise reuse a previous capture.
    captureOptions.invalidate ??= true
    // Every recording frame owns its pixels; an inherited reusable output canvas
    // would otherwise turn the entire sequence into copies of the last frame.
    captureOptions.canvas = null
    if (operationOptions.scale != null) captureOptions.scale = Number(operationOptions.scale)
    let canvas
    try {
      const result = await options.snapdom(element, captureOptions)
      if (typeof result?.toCanvas === 'function') canvas = await result.toCanvas({ canvas: null })
      else if (typeof options.snapdom.toCanvas === 'function') canvas = await options.snapdom.toCanvas(element, captureOptions)
      // SnapDOM rasterizes its serialized viewBox, which can be larger than
      // the element's logical box when root transforms or bleed are present.
      // Using that viewport keeps target-css-px axis-aligned with the file and
      // preserves one effective raster scale for both dimensions.
      if (result?.meta?.vbW > 0 && result?.meta?.vbH > 0) {
        fallbackCss.width = result.meta.vbW
        fallbackCss.height = result.meta.vbH
      } else if (result?.meta?.w0 > 0 && result?.meta?.h0 > 0) {
        fallbackCss.width = result.meta.w0
        fallbackCss.height = result.meta.h0
      }
    } catch (error) {
      throw operationError(error, 'capture')
    }
    if (!canvas || !(canvas.width > 0) || !(canvas.height > 0)) {
      throw new SnapEyeError(ERROR_CODES.CAPTURE_FAILED, 'SnapEye produced an empty capture')
    }
    const image = buildImageMeta({
      cssWidth: fallbackCss.width,
      cssHeight: fallbackCss.height,
      pixelWidth: canvas.width,
      pixelHeight: canvas.height
    }, COORDINATE_SPACE)
    return { canvas, image, blob: includeBlob ? await canvasToPng(canvas) : null }
  }

  function resolveTarget (input, operationOptions) {
    const fallback = options.defaultTarget ? options.defaultTarget() : documentImpl.documentElement
    const requested = input ?? operationOptions.target ?? fallback ?? documentImpl.documentElement
    let element = requested
    let selector
    if (typeof requested === 'string') {
      selector = requested
      try { element = documentImpl.querySelector(requested) } catch { element = null }
    }
    if (!isElement(element)) {
      throw new SnapEyeError(ERROR_CODES.TARGET_NOT_FOUND, `SnapEye target was not found: ${selector || describeTarget(requested)}`)
    }
    return { element, meta: selector ? { selector } : descriptorForElement(element) }
  }

  async function blobToCanvas (blob) {
    const canvas = documentImpl.createElement('canvas')
    if (typeof windowImpl.createImageBitmap === 'function') {
      const bitmap = await windowImpl.createImageBitmap(blob)
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      canvas.getContext('2d').drawImage(bitmap, 0, 0)
      bitmap.close?.()
      return canvas
    }
    const image = new windowImpl.Image()
    const objectUrl = windowImpl.URL.createObjectURL(blob)
    try {
      await new Promise((resolve, reject) => {
        image.onload = resolve
        image.onerror = () => reject(new Error('Baseline PNG could not be decoded'))
        image.src = objectUrl
      })
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      canvas.getContext('2d').drawImage(image, 0, 0)
      return canvas
    } finally {
      windowImpl.URL.revokeObjectURL(objectUrl)
    }
  }

  async function canvasToPng (canvas) {
    if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: 'image/png' })
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Canvas PNG export failed')), 'image/png')
    })
  }

  function normalizeFrame (canvas, width, height) {
    if (canvas.width === width && canvas.height === height) return canvas
    const fixed = documentImpl.createElement('canvas')
    fixed.width = width
    fixed.height = height
    fixed.getContext('2d').drawImage(canvas, 0, 0, width, height)
    return fixed
  }

  async function withHiddenElements (work) {
    const hidden = []
    for (const selector of options.hideSelectors || []) {
      let elements = []
      try { elements = documentImpl.querySelectorAll(selector) } catch {}
      elements.forEach(element => {
        hidden.push([element, element.style.display])
        element.style.display = 'none'
      })
    }
    try {
      return await work()
    } finally {
      hidden.forEach(([element, display]) => { element.style.display = display })
    }
  }

  function log (level, ...args) {
    if (!options.forwardConsole) return Promise.resolve(false)
    return store.log ? store.log(level, ...args) : Promise.resolve(false)
  }

  function reportTechnical (error) {
    const output = originalConsole.error || windowImpl.console.error.bind(windowImpl.console)
    output('[snapeye]', error)
  }

  function showError (message) {
    if (!options.errorOverlay) return
    if (!errorBox) {
      errorBox = documentImpl.createElement('div')
      errorBox.id = '__snapeye_err__'
      errorBox.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#c0392b;color:#fff;font:13px/1.4 ui-monospace,Menlo,monospace;padding:10px 16px;max-height:40vh;overflow:auto;white-space:pre-wrap'
      const close = documentImpl.createElement('button')
      close.type = 'button'
      close.textContent = '×'
      close.setAttribute('aria-label', 'Close SnapEye error overlay')
      close.style.cssText = 'float:right;background:none;border:0;color:inherit;font:20px/1 monospace;cursor:pointer'
      close.onclick = () => { errorBox.remove(); errorBox = null }
      errorBox.appendChild(close)
      documentImpl.body?.appendChild(errorBox)
    }
    const row = documentImpl.createElement('div')
    row.textContent = message
    errorBox.appendChild(row)
    log('error', message)
  }

  function installConsoleForwarding () {
    if (!options.forwardConsole) return
    ;['log', 'warn', 'error', 'info'].forEach(method => {
      const original = windowImpl.console[method]?.bind(windowImpl.console)
      if (!original) return
      originalConsole[method] = original
      windowImpl.console[method] = (...args) => { original(...args); log(method, ...args) }
    })
  }

  const onWindowError = event => showError(`ERROR: ${event.message} (${event.filename}:${event.lineno})`)
  const onUnhandledRejection = event => showError(`PROMISE: ${event.reason?.message || event.reason || event}`)
  const onKeydown = event => {
    if (!options.hotkey) return
    // A modifier combination belongs to the browser or the application, and a
    // keystroke aimed at an editable field belongs to whoever is typing:
    // capture() replaces a committable baseline, so it never steals either.
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (!event.shiftKey || typeof event.key !== 'string') return
    if (event.key.toUpperCase() !== String(options.hotkey).toUpperCase()) return
    if (isEditableEventTarget(event)) return
    event.preventDefault()
    capture(options.hotkeyName || 'current').catch(reportTechnical)
  }

  function installListeners () {
    installConsoleForwarding()
    if (options.errorOverlay) {
      windowImpl.addEventListener('error', onWindowError)
      windowImpl.addEventListener('unhandledrejection', onUnhandledRejection)
    }
    if (options.hotkey) documentImpl.addEventListener('keydown', onKeydown)
  }

  function destroy () {
    Object.entries(originalConsole).forEach(([method, original]) => { windowImpl.console[method] = original })
    windowImpl.removeEventListener('error', onWindowError)
    windowImpl.removeEventListener('unhandledrejection', onUnhandledRejection)
    documentImpl.removeEventListener('keydown', onKeydown)
    errorBox?.remove()
    delete windowImpl[RUNTIME_STATE]
  }

  async function runUrlTrigger (href = windowImpl.location.href) {
    const url = new URL(href)
    const hasOperation = url.searchParams.has(TRIGGER_PARAM)
    const operation = hasOperation ? url.searchParams.get(TRIGGER_PARAM) : null
    const legacyName = !hasOperation ? url.searchParams.get('snap') : null
    if (!hasOperation && !legacyName) return null
    if (legacyName) return capture(legacyName === '1' ? 'current' : legacyName)

    const runId = url.searchParams.get('run')
    const name = url.searchParams.get('name')
    if (!runId || !isValidRunId(runId)) {
      reportTechnical(new SnapEyeError(
        ERROR_CODES.INVALID_RUN_ID,
        'SnapEye URL operations require a valid `run` parameter (1-64 chars of [A-Za-z0-9_-])'
      ))
      return null
    }
    const target = url.searchParams.get('target') || undefined
    const urlOptions = {
      runId,
      duration: url.searchParams.get('duration') || undefined,
      fps: url.searchParams.get('fps') || undefined,
      format: url.searchParams.get('format') || undefined,
      scale: url.searchParams.get('scale') || undefined,
      waitFor: url.searchParams.get('wait') || undefined,
      stabilize: url.searchParams.get('stabilize') === '0' ? false : undefined,
      settle: url.searchParams.get('settle') === '0' ? false : undefined
    }
    if (operation === 'capture') return capture(name, target, urlOptions)
    if (operation === 'diff') return diff(name, target, urlOptions)
    if (operation === 'record') return record(name, target, urlOptions)
    return execute(operation, name, target, urlOptions)
  }

  function queueUrlTrigger () {
    const run = () => windowImpl.setTimeout(() => runUrlTrigger().catch(reportTechnical), Math.max(0, options.triggerDelay))
    if (documentImpl.readyState === 'loading') documentImpl.addEventListener('DOMContentLoaded', run, { once: true })
    else run()
  }

  const api = {
    capture,
    diff,
    record,
    snap: capture,
    log,
    runUrlTrigger,
    destroy,
    options: publicOptions(options),
    protocolVersion: PROTOCOL_VERSION
  }
  windowImpl.snapeye = api
  windowImpl[RUNTIME_STATE] = { api }
  installListeners()
  if (options.autoOnQuery) queueUrlTrigger()
  return api
}

function normalizeCall (target, options) {
  if (options == null && isOptionsObject(target)) return { target: undefined, options: target }
  return { target, options: options || {} }
}

function isOptionsObject (value) {
  return value && typeof value === 'object' && !isElement(value) && !Array.isArray(value)
}

/**
 * True when the keystroke is being typed into a field. `hotkey` performs a real
 * `capture()`, which replaces a baseline that is meant to be committed, so an
 * accidental Shift+S inside a form must never trigger it (or be swallowed by
 * `preventDefault`).
 */
function isEditableEventTarget (event) {
  const target = event?.target
  if (!target || typeof target !== 'object') return false
  if (target.isContentEditable === true) return true
  const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : ''
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function isElement (value) {
  return value != null && value.nodeType === 1 && typeof value.tagName === 'string'
}

function descriptorForElement (element) {
  if (element.id) return { selector: `#${safeCssIdentifier(element.id)}` }
  const tag = element.tagName.toLowerCase()
  const classes = Array.from(element.classList || []).slice(0, 3)
  return { descriptor: classes.length ? `${tag}.${classes.map(safeCssIdentifier).join('.')}` : tag }
}

function safeCssIdentifier (value) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value)
  return String(value).replace(/[^A-Za-z0-9_-]/g, character => `\\${character}`)
}

function describeTarget (target) {
  if (target == null) return 'default target'
  if (typeof target === 'string') return target
  return Object.prototype.toString.call(target)
}

function readCssSize (element) {
  const rect = element.getBoundingClientRect()
  const width = rect.width || element.scrollWidth || element.clientWidth
  const height = rect.height || element.scrollHeight || element.clientHeight
  if (!(width > 0) || !(height > 0)) {
    throw new SnapEyeError(ERROR_CODES.CAPTURE_FAILED, 'SnapEye target has no visible dimensions')
  }
  return { width, height }
}

function validateBaselineMetadata (meta, name) {
  if (!meta || meta.schemaVersion !== SCHEMA_VERSION || !meta.image || meta.name !== name) {
    throw new SnapEyeError(ERROR_CODES.BASELINE_INCOMPATIBLE, `Baseline ${name} has missing or unsupported metadata`)
  }
}

function assertBaselineCompatible (meta, canvas, current) {
  const baseline = meta.image
  const rasterMatches = canvas.width === baseline.pixelWidth && canvas.height === baseline.pixelHeight &&
    current.pixelWidth === baseline.pixelWidth && current.pixelHeight === baseline.pixelHeight
  const cssMatches = nearlyEqual(current.cssWidth, baseline.cssWidth, 0.5) &&
    nearlyEqual(current.cssHeight, baseline.cssHeight, 0.5)
  const scaleMatches = nearlyEqual(current.scale, baseline.scale, 0.01)
  if (!rasterMatches || !cssMatches || !scaleMatches) {
    throw new SnapEyeError(ERROR_CODES.BASELINE_INCOMPATIBLE, 'Baseline and current capture use incompatible dimensions or scale', {
      baseline: {
        cssWidth: baseline.cssWidth,
        cssHeight: baseline.cssHeight,
        pixelWidth: baseline.pixelWidth,
        pixelHeight: baseline.pixelHeight,
        scale: baseline.scale
      },
      current
    })
  }
}

function nearlyEqual (left, right, tolerance) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance
}

function normalizeRecordFormat (value) {
  const format = value || 'gif'
  if (format === 'gif' || format === 'video' || format === 'both') return format
  throw new SnapEyeError(ERROR_CODES.RECORD_FAILED, 'Record format must be "gif", "video", or "both"')
}

function needsRegionMask (options) {
  if (options.diffMask) return false
  const [r, g, b] = options.diffColor ?? [255, 0, 0]
  if (r === g && g === b) return true
  const aaColor = options.aaColor ?? [255, 255, 0]
  return !options.includeAA && r === aaColor[0] && g === aaColor[1] && b === aaColor[2]
}

function roundTimestamp (value) {
  return Math.max(0, Math.round(value))
}

function assertArtifactStore (store) {
  for (const method of ['readBaseline', 'writeBaseline', 'writeRunArtifact', 'commitResult']) {
    if (typeof store?.[method] !== 'function') throw new TypeError(`SnapEye ArtifactStore is missing ${method}()`)
  }
}

function publicOptions (options) {
  return {
    endpoint: options.endpoint,
    autoOnQuery: options.autoOnQuery,
    forwardConsole: options.forwardConsole,
    errorOverlay: options.errorOverlay,
    hotkey: options.hotkey,
    hotkeyName: options.hotkeyName || 'current',
    hideSelectors: [...(options.hideSelectors || [])],
    stabilize: options.stabilize !== false,
    settle: options.settle !== false,
    waitFor: options.waitFor ?? null,
    snapdomOptions: { ...options.snapdomOptions }
  }
}

export default attachSnapEye
