import { describe, expect, it, vi } from 'vitest'
import { FREEZE_ATTRIBUTE, freezeMotion, waitForReady, waitForSettled } from '../../src/client/stability.js'

describe('capture stability', () => {
  it('installs the paused stylesheet before rewinding, which is what makes the frame stick', async () => {
    const order = []
    const spinner = fakeAnimation({ iterations: Infinity, currentTime: 812, onWrite: () => order.push('rewind') })
    const document = fakeDocument([spinner], { onAppend: () => order.push('stylesheet') })

    await freezeMotion(document, { window: fakeWindow() })

    // Pausing through the API first does not hold: the CSS property re-takes
    // control on the next style resolution and the animation slips a frame.
    expect(order).toEqual(['stylesheet', 'rewind'])
    expect(document.head.children).toHaveLength(1)
    expect(document.head.children[0].attributes[FREEZE_ATTRIBUTE]).toBe('')
    expect(document.head.children[0].textContent).toContain('animation-play-state: paused !important')
  })

  it('rewinds endless animations to a chosen frame instead of an observed one', async () => {
    const spinner = fakeAnimation({ iterations: Infinity, currentTime: 812 })

    await freezeMotion(fakeDocument([spinner]), { window: fakeWindow() })

    expect(spinner.currentTime).toBe(0)
    expect(spinner.playState).toBe('paused')
    expect(spinner.finish).not.toHaveBeenCalled()
  })

  it('fast-forwards finite animations and in-flight transitions to their settled state', async () => {
    const transition = fakeAnimation({ iterations: 1, duration: 900, currentTime: 120 })

    await freezeMotion(fakeDocument([transition]), { window: fakeWindow() })

    expect(transition.finish).toHaveBeenCalledOnce()
    expect(transition.currentTime).toBe(900)
  })

  it('gives the live page back exactly as it was found', async () => {
    const spinner = fakeAnimation({ iterations: Infinity, currentTime: 812, playState: 'running' })
    const paused = fakeAnimation({ iterations: Infinity, currentTime: 40, playState: 'paused' })
    const document = fakeDocument([spinner, paused])

    const restore = await freezeMotion(document, { window: fakeWindow() })
    restore()

    expect(spinner.currentTime).toBe(812)
    expect(spinner.playState).toBe('running')
    expect(paused.currentTime).toBe(40)
    expect(paused.playState).toBe('paused')
    expect(document.head.children).toHaveLength(0)
  })

  it('keeps freezing the rest of the page when one animation refuses', async () => {
    const hostile = fakeAnimation({ iterations: Infinity, currentTime: 250 })
    hostile.pause = vi.fn(() => { throw new Error('replaced') })
    const spinner = fakeAnimation({ iterations: Infinity, currentTime: 500 })

    const restore = await freezeMotion(fakeDocument([hostile, spinner]), { window: fakeWindow() })

    expect(spinner.currentTime).toBe(0)
    expect(() => restore()).not.toThrow()
    expect(hostile.currentTime).toBe(250)
  })

  it('restores the original CSS animation state from before the stylesheet paused it', async () => {
    const spinner = fakeAnimation({ iterations: Infinity, currentTime: 812 })
    const document = fakeDocument([spinner], {
      onAppend: () => { spinner.playState = 'paused' }
    })

    const restore = await freezeMotion(document, { window: fakeWindow() })
    expect(spinner.playState).toBe('paused')
    expect(spinner.currentTime).toBe(0)

    restore()
    expect(spinner.playState).toBe('running')
    expect(spinner.currentTime).toBe(812)
    expect(document.head.children).toHaveLength(0)
  })

  it('is a no-op on a document without the animations API', async () => {
    const document = fakeDocument([])
    delete document.getAnimations

    const restore = await freezeMotion(document, { window: fakeWindow() })

    expect(document.head.children).toHaveLength(1)
    restore()
    expect(document.head.children).toHaveLength(0)
  })

  it('falls back to a timer when the document has no animation frames', async () => {
    const wait = vi.fn(async () => {})
    const spinner = fakeAnimation({ iterations: Infinity, currentTime: 300 })

    await freezeMotion(fakeDocument([spinner]), { window: {}, wait })

    expect(wait).toHaveBeenCalledTimes(2)
    expect(spinner.currentTime).toBe(0)
  })

  it('removes the freeze stylesheet if waiting for a frame fails', async () => {
    const spinner = fakeAnimation({ iterations: Infinity, currentTime: 300 })
    const document = fakeDocument([spinner])

    await expect(freezeMotion(document, {
      window: {},
      wait: async () => { throw new Error('Frame wait failed') }
    })).rejects.toThrow('Frame wait failed')

    expect(document.head.children).toHaveLength(0)
    expect(spinner.currentTime).toBe(300)
    expect(spinner.playState).toBe('running')
  })

  it('pins motion even when a background page receives no animation frames', async () => {
    vi.useFakeTimers()
    try {
      const spinner = fakeAnimation({ iterations: Infinity, currentTime: 300 })
      const window = {
        requestAnimationFrame: vi.fn(() => 1),
        cancelAnimationFrame: vi.fn()
      }
      const pending = freezeMotion(fakeDocument([spinner]), { window })

      await vi.advanceTimersByTimeAsync(200)
      const restore = await pending

      expect(spinner.currentTime).toBe(0)
      expect(window.cancelAnimationFrame).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
      restore()
      expect(spinner.playState).toBe('running')
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears fallback timers as soon as foreground animation frames arrive', async () => {
    vi.useFakeTimers()
    try {
      const restore = await freezeMotion(fakeDocument([]), { window: fakeWindow() })
      expect(vi.getTimerCount()).toBe(0)
      restore()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('waitForSettled', () => {
  const frameWindow = () => ({
    requestAnimationFrame: callback => callback(1),
    performance: { now: () => 0 }
  })

  it('returns once the page geometry stops changing', async () => {
    let height = 100
    const document = growingDocument(() => (height < 400 ? (height += 100) : height))

    await waitForSettled({ document, window: frameWindow() })

    // Three consecutive identical readings, not a guessed delay.
    expect(height).toBe(400)
  })

  it('gives up at the budget instead of hanging on a page that never settles', async () => {
    let clock = 0
    let height = 0
    const windowImpl = {
      requestAnimationFrame: callback => { clock += 16; callback(clock) },
      performance: { now: () => clock }
    }
    const document = growingDocument(() => (height += 10))

    await waitForSettled({ document, window: windowImpl, budgetMs: 100 })

    expect(clock).toBeGreaterThanOrEqual(100)
    expect(clock).toBeLessThan(400)
  })

  it('includes the captured target in the signature', async () => {
    let width = 10
    const document = growingDocument(() => 500)
    const element = { getBoundingClientRect: () => ({ width: (width += 10), height: 20 }) }
    let clock = 0
    const windowImpl = {
      requestAnimationFrame: callback => { clock += 16; callback(clock) },
      performance: { now: () => clock }
    }

    await waitForSettled({ document, window: windowImpl, element, budgetMs: 100 })

    // The page was quiet the whole time; only the target moved, and that is
    // enough to keep waiting.
    expect(clock).toBeGreaterThanOrEqual(100)
  })

  it('does nothing without a document or a budget', async () => {
    await expect(waitForSettled({ document: null, window: frameWindow() })).resolves.toBeUndefined()
    await expect(waitForSettled({ document: growingDocument(() => 1), window: frameWindow(), budgetMs: 0 }))
      .resolves.toBeUndefined()
  })

  it('honours its time budget when requestAnimationFrame never fires', async () => {
    vi.useFakeTimers()
    try {
      let height = 0
      const window = {
        requestAnimationFrame: vi.fn(() => 1),
        cancelAnimationFrame: vi.fn(),
        performance: { now: () => Date.now() }
      }
      const pending = waitForSettled({
        document: growingDocument(() => ++height),
        window,
        budgetMs: 200
      })

      await vi.advanceTimersByTimeAsync(200)
      await pending

      expect(window.requestAnimationFrame).toHaveBeenCalledTimes(2)
      expect(window.cancelAnimationFrame).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

function growingDocument (nextHeight) {
  return {
    readyState: 'complete',
    images: { length: 2 },
    styleSheets: { length: 3 },
    get documentElement () {
      return { scrollWidth: 800, scrollHeight: nextHeight() }
    }
  }
}

describe('waitForReady', () => {
  const clock = () => {
    let time = 0
    return {
      now: () => time,
      wait: vi.fn(async ms => { time += ms })
    }
  }

  it('does nothing without a specification', async () => {
    const { now, wait } = clock()
    await waitForReady(undefined, { document: fakeDocument([]), wait, now })
    await waitForReady('', { document: fakeDocument([]), wait, now })
    expect(wait).not.toHaveBeenCalled()
  })

  it.each([[250, 250], ['250', 250]])('waits %s as milliseconds', async (spec, expected) => {
    const { now, wait } = clock()
    await waitForReady(spec, { document: fakeDocument([]), wait, now })
    expect(wait).toHaveBeenCalledWith(expected)
  })

  it('resolves as soon as the selector matches', async () => {
    const { now, wait } = clock()
    let appearances = 0
    const document = { querySelector: () => (++appearances >= 3 ? { nodeType: 1 } : null) }

    await waitForReady('#ready', { document, wait, now })

    expect(appearances).toBe(3)
    expect(wait).toHaveBeenCalledTimes(2)
  })

  it('fails with a public message when the selector never appears', async () => {
    const { now, wait } = clock()
    const document = { querySelector: () => null }

    await expect(waitForReady('#never', { document, wait, now, timeoutMs: 500 }))
      .rejects.toMatchObject({
        code: 'CAPTURE_FAILED',
        publicMessage: 'SnapEye waited 500ms for #never and it never appeared'
      })
  })

  it('rejects an unusable selector instead of spinning', async () => {
    const { now, wait } = clock()
    const document = { querySelector: () => { throw new SyntaxError('bad selector') } }

    await expect(waitForReady('###', { document, wait, now }))
      .rejects.toMatchObject({ code: 'CAPTURE_FAILED' })
  })
})

function fakeWindow () {
  return { requestAnimationFrame: callback => callback(1) }
}

function fakeDocument (animations, { onAppend } = {}) {
  const children = []
  return {
    getAnimations: () => animations,
    createElement: () => ({
      attributes: {},
      textContent: '',
      setAttribute (name, value) { this.attributes[name] = value },
      remove () {
        const index = children.indexOf(this)
        if (index >= 0) children.splice(index, 1)
      }
    }),
    head: {
      children,
      appendChild (node) {
        onAppend?.()
        children.push(node)
      }
    },
    querySelector: () => null
  }
}

function fakeAnimation ({ iterations = 1, duration = 1000, currentTime = 0, playState = 'running', onWrite } = {}) {
  return {
    effect: { getComputedTiming: () => ({ iterations, duration }) },
    _currentTime: currentTime,
    get currentTime () { return this._currentTime },
    set currentTime (value) {
      onWrite?.()
      this._currentTime = value
    },
    playState,
    pause: vi.fn(function () { this.playState = 'paused' }),
    play: vi.fn(function () { this.playState = 'running' }),
    finish: vi.fn(function () {
      if (!Number.isFinite(iterations) || !Number.isFinite(duration)) throw new Error('InvalidStateError')
      this._currentTime = duration * iterations
      this.playState = 'finished'
    })
  }
}
