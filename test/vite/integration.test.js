import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build, createServer } from 'vite'
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { snapeye } from '../../src/vite.js'

// Read the real version: hardcoding it means every release bump fails the
// suite for a reason that has nothing to do with the contract.
const { version: VERSION } = createRequire(import.meta.url)('../../package.json')

const here = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = join(here, '..', 'fixtures', 'vite-app')
const chromePath = findChrome()
// A silent skip makes a green run look like it exercised the browser when it
// never did. Locally it is a loud warning; under CI or `npm run test:browser`
// (which `prepublishOnly` uses) a missing browser fails the suite instead.
const browserRequired = process.env.SNAPEYE_REQUIRE_BROWSER === '1' || process.env.CI === 'true'

if (!chromePath) {
  console.warn(
    '\n[snapeye] Vite integration tests SKIPPED: no Chrome/Chromium executable found.\n' +
    '          Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, or run `npm run test:browser`\n' +
    '          to turn this skip into a failure.\n'
  )
}

describe.runIf(browserRequired)('Vite integration prerequisites', () => {
  it('finds the browser the integration suite requires', () => {
    expect(
      chromePath,
      'No Chrome/Chromium found. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to run the integration suite.'
    ).toBeTruthy()
  })
})

describe.skipIf(!chromePath).sequential('Vite integration', () => {
  let temporaryRoot
  let artifactRoot
  let server
  let browser
  let page
  let baseUrl

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'snapeye-vite-'))
    artifactRoot = join(temporaryRoot, '.snapeye')
    await seedOldRuns(artifactRoot)
    server = await startServer(artifactRoot)
    baseUrl = server.resolvedUrls.local[0]
    browser = await chromium.launch({
      headless: true,
      executablePath: chromePath,
      args: ['--no-sandbox']
    })
    page = await browser.newPage()
  }, 30_000)

  afterAll(async () => {
    await page?.close().catch(() => {})
    await browser?.close().catch(() => {})
    await server?.close().catch(() => {})
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
  })

  it('serves health before any page client initializes and prunes safely', async () => {
    const response = await fetch(new URL('/__snapeye/health', baseUrl))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ok',
      name: '@zumer/snapeye',
      version: VERSION,
      protocolVersion: 1,
      artifactRoot,
      // Absolute, so a CLI invoked from anywhere finds the artifacts.
      artifactRootResolved: artifactRoot
    })

    const initialRuns = (await readdir(join(artifactRoot, 'runs'))).sort()
    expect(initialRuns).toEqual(['old_2', 'old_3', 'old_4'])
    expect(await readFile(join(artifactRoot, 'baselines', 'keep.txt'), 'utf8')).toBe('baseline sentinel')
    expect(await readFile(join(artifactRoot, '.gitignore'), 'utf8')).toBe('custom-entry\nruns/\n*.tmp\n')
  })

  it('injects the client and capture publishes a baseline plus terminal result', async () => {
    const runId = 'capture_001'
    await page.goto(operationUrl('capture', 'dashboard', runId), { waitUntil: 'load' })
    const result = await waitForResult(runId)

    expect(await page.evaluate(() => ({
      ready: window.__snapeyeFixtureReady,
      methods: ['capture', 'diff', 'record', 'snap'].map(name => typeof window.snapeye?.[name])
    }))).toEqual({ ready: true, methods: ['function', 'function', 'function', 'function'] })
    expect(result).toMatchObject({
      schemaVersion: 1,
      protocolVersion: 1,
      runId,
      status: 'ok',
      operation: 'capture',
      name: 'dashboard',
      target: { selector: '#target' },
      artifacts: { baseline: '../../baselines/dashboard.png' }
    })
    expect(result.image).toMatchObject({
      coordinateSpace: 'target-css-px',
      cssWidth: 320,
      cssHeight: 180
    })
    await expectFile(join(artifactRoot, 'baselines', 'dashboard.png'))
    const metadata = JSON.parse(await readFile(join(artifactRoot, 'baselines', 'dashboard.json'), 'utf8'))
    expect(metadata).toMatchObject({ schemaVersion: 1, name: 'dashboard' })
  }, 30_000)

  it('waits for a hydrated target before resolving and capturing it', async () => {
    await page.goto(baseUrl, { waitUntil: 'load' })
    await page.waitForFunction(() => !!window.snapeye)
    await page.evaluate(async () => {
      const target = document.querySelector('#target')
      const hydrated = target.cloneNode(true)
      target.remove()
      setTimeout(() => document.body.appendChild(hydrated), 50)
      await window.snapeye.capture('hydrated', '#target', {
        runId: 'hydrated_capture',
        waitFor: '#target'
      })
    })

    const result = await waitForResult('hydrated_capture')
    expect(result).toMatchObject({
      status: 'ok',
      target: { selector: '#target' },
      image: { cssWidth: 320, cssHeight: 180 }
    })
  }, 30_000)

  it('diff reads the baseline and keeps runs isolated', async () => {
    const runId = 'diff_001'
    await page.goto(`${operationUrl('diff', 'dashboard', runId)}&variant=changed`, { waitUntil: 'load' })
    const result = await waitForResult(runId)

    expect(result).toMatchObject({
      status: 'ok',
      operation: 'diff',
      runId,
      diff: {
        changed: true,
        regionsTruncated: false
      },
      artifacts: {
        current: 'current.png',
        diff: 'diff.png'
      }
    })
    expect(result.diff.changedRatio).toBeGreaterThan(0)
    expect(result.diff.changedRatio).toBeLessThanOrEqual(1)
    expect(result.diff.regionCount).toBeGreaterThan(0)
    await expectFile(join(artifactRoot, 'runs', runId, 'current.png'))
    await expectFile(join(artifactRoot, 'runs', runId, 'diff.png'))
    await expectFile(join(artifactRoot, 'runs', 'capture_001', 'result.json'))
    await expect(access(join(artifactRoot, 'result.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('extracts only real changes when the diff colour matches the grey pixel wash', async () => {
    await page.goto(baseUrl, { waitUntil: 'load' })
    await page.waitForFunction(() => !!window.snapeye)
    await page.evaluate(async () => {
      const target = document.createElement('canvas')
      target.id = 'grey-colour-target'
      target.width = 80
      target.height = 60
      document.body.appendChild(target)
      const context = target.getContext('2d')
      context.fillStyle = 'black'
      context.fillRect(0, 0, 80, 60)
      await window.snapeye.capture('grey-colour', target, { runId: 'grey_capture' })
      const diffOptions = {
        diffOptions: { diffColor: [230, 230, 230] },
        regionOptions: { tileSize: 1, gapTiles: 1, minRegionCssSide: 0, minRegionCssArea: 0 }
      }
      await window.snapeye.diff('grey-colour', target, { ...diffOptions, runId: 'grey_unchanged' })
      context.fillStyle = 'white'
      context.fillRect(3, 4, 2, 2)
      await window.snapeye.diff('grey-colour', target, { ...diffOptions, runId: 'grey_changed' })
    })

    expect((await waitForResult('grey_capture')).status).toBe('ok')
    expect(await waitForResult('grey_unchanged')).toMatchObject({
      status: 'ok',
      diff: { changed: false, changedRatio: 0, regionCount: 0, regions: [] }
    })
    const changed = await waitForResult('grey_changed')
    expect(changed).toMatchObject({
      status: 'ok',
      diff: {
        changed: true,
        regionCount: 1,
        regions: [{ x: 3, y: 4, width: 2, height: 2, aggregate: false }]
      }
    })
    expect(changed.diff.changedRatio).toBeCloseTo(4 / (80 * 60), 6)
  }, 30_000)

  it('publishes BASELINE_NOT_FOUND instead of inventing a comparison', async () => {
    const runId = 'diff_missing_baseline_001'
    await page.goto(operationUrl('diff', 'never-captured', runId), { waitUntil: 'load' })
    const result = await waitForResult(runId)

    expect(result).toMatchObject({
      runId,
      status: 'error',
      operation: 'diff',
      name: 'never-captured',
      error: { code: 'BASELINE_NOT_FOUND' }
    })
    expect(result).not.toHaveProperty('diff')
    expect(result.error).not.toHaveProperty('stack')
    await expect(access(join(artifactRoot, 'runs', runId, 'current.png')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(join(artifactRoot, 'baselines', 'never-captured.png')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('keeps transformed targets in one axis-aligned capture-viewport coordinate space', async () => {
    const captureRunId = 'rotated_capture_001'
    const captureUrl = new URL(operationUrl('capture', 'rotated', captureRunId))
    captureUrl.searchParams.set('transform', 'rotated')
    captureUrl.searchParams.set('scale', '1.5')
    await page.goto(captureUrl.href, { waitUntil: 'load' })
    const captured = await waitForResult(captureRunId)
    const liveGeometry = await page.evaluate(() => {
      const target = document.querySelector('#target')
      const rect = target.getBoundingClientRect()
      return {
        logicalWidth: target.offsetWidth,
        logicalHeight: target.offsetHeight,
        boundingWidth: rect.width,
        boundingHeight: rect.height
      }
    })

    expect(captured.status).toBe('ok')
    expect(captured.target).toEqual({ selector: '#target' })
    expect(liveGeometry).toMatchObject({ logicalWidth: 320, logicalHeight: 180 })
    expect(liveGeometry.boundingWidth).toBeGreaterThan(liveGeometry.logicalWidth)
    expect(liveGeometry.boundingHeight).toBeGreaterThan(liveGeometry.logicalHeight)
    expect(captured.image).toMatchObject({
      coordinateSpace: 'target-css-px',
      scale: 1.5
    })
    // SnapDOM's viewBox includes the transformed bounding box plus its small
    // raster safety margin. It is the CSS viewport that maps 1:1 to this PNG.
    expect(captured.image.cssWidth).toBeGreaterThan(liveGeometry.boundingWidth)
    expect(captured.image.cssHeight).toBeGreaterThan(liveGeometry.boundingHeight)
    expect(captured.image.pixelWidth).toBe(captured.image.cssWidth * captured.image.scale)
    expect(captured.image.pixelHeight).toBe(captured.image.cssHeight * captured.image.scale)

    const diffRunId = 'rotated_diff_001'
    const diffUrl = new URL(operationUrl('diff', 'rotated', diffRunId))
    diffUrl.searchParams.set('transform', 'rotated')
    diffUrl.searchParams.set('variant', 'changed')
    diffUrl.searchParams.set('scale', '1.5')
    await page.goto(diffUrl.href, { waitUntil: 'load' })
    const diffed = await waitForResult(diffRunId)

    expect(diffed).toMatchObject({
      status: 'ok',
      operation: 'diff',
      image: captured.image,
      diff: { changed: true }
    })
    expect(diffed.diff.regionCount).toBeGreaterThan(0)
    for (const region of diffed.diff.regions) {
      expect(region.x).toBeGreaterThanOrEqual(0)
      expect(region.y).toBeGreaterThanOrEqual(0)
      expect(region.x + region.width).toBeLessThanOrEqual(diffed.image.cssWidth)
      expect(region.y + region.height).toBeLessThanOrEqual(diffed.image.cssHeight)
    }
  }, 40_000)

  it('publishes a terminal target error under the caller run only', async () => {
    const runId = 'missing_001'
    const url = new URL(operationUrl('capture', 'missing', runId))
    url.searchParams.set('target', '#does-not-exist')
    await page.goto(url.href, { waitUntil: 'load' })
    const result = await waitForResult(runId)
    expect(result).toMatchObject({
      runId,
      status: 'error',
      operation: 'capture',
      error: { code: 'TARGET_NOT_FOUND' }
    })
  })

  it('record creates GIF and filmstrip from one measured frame sequence', async () => {
    const runId = 'record_gif_001'
    const url = `${operationUrl('record', 'motion', runId)}&duration=500&fps=5&format=gif`
    await page.goto(url, { waitUntil: 'load' })
    const result = await waitForResult(runId, 30_000)

    expect(result).toMatchObject({
      status: 'ok',
      operation: 'record',
      record: {
        durationRequestedMs: 500,
        fpsRequested: 5,
        format: 'gif'
      },
      artifacts: {
        frames: 'frames.png',
        gif: 'recording.gif'
      }
    })
    expect(result.record.frameCount).toBe(result.record.timestampsMs.length)
    expect(result.record.frameCount).toBeGreaterThan(1)
    expect(result.record.fpsActual).toBeGreaterThan(0)
    expect(result.record.filmstrip.cells.length).toBeLessThanOrEqual(12)
    expect(result.record.filmstrip.cells[0].timestampMs).toBe(result.record.timestampsMs[0])
    await expectFile(join(artifactRoot, 'runs', runId, 'frames.png'))
    await expectFile(join(artifactRoot, 'runs', runId, 'recording.gif'))
  }, 40_000)

  it('the ad hoc video adapter consumes the same collected-frame contract', async () => {
    const runId = 'record_video_001'
    const url = `${operationUrl('record', 'motion', runId)}&duration=500&fps=5&format=video`
    await page.goto(url, { waitUntil: 'load' })
    const result = await waitForResult(runId, 30_000)

    expect(result.status).toBe('ok')
    expect(result.record.format).toBe('video')
    expect(['recording.webm', 'recording.mp4']).toContain(result.artifacts.video)
    await expectFile(join(artifactRoot, 'runs', runId, result.artifacts.video))
    await expectFile(join(artifactRoot, 'runs', runId, 'frames.png'))
  }, 40_000)

  it('reports no change on an animated page, run after run', async () => {
    // Without pinned motion this is the tool's worst failure: a spinner lands
    // on a different frame each run and the agent chases a regression nobody
    // introduced. Measured at 7 false positives out of 8 before stabilization.
    const baseUrlWithMotion = url => {
      const value = new URL(url)
      value.searchParams.set('motion', 'css')
      return value.href
    }

    await page.goto(baseUrlWithMotion(operationUrl('capture', 'animated', 'anim_base')), { waitUntil: 'load' })
    expect((await waitForResult('anim_base')).status).toBe('ok')

    const restoredMotion = await page.evaluate(async () => {
      const animations = document.getAnimations()
      const times = animations.map(animation => Number(animation.currentTime))
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return {
        states: animations.map(animation => animation.playState),
        advanced: animations.map((animation, index) => Number(animation.currentTime) > times[index]),
        frozen: !!document.querySelector('[data-snapeye-freeze]')
      }
    })
    expect(restoredMotion).toEqual({
      states: ['running', 'running'],
      advanced: [true, true],
      frozen: false
    })

    const verdicts = []
    for (let attempt = 0; attempt < 4; attempt++) {
      const runId = `anim_diff_${attempt}`
      await page.goto(baseUrlWithMotion(operationUrl('diff', 'animated', runId)), { waitUntil: 'load' })
      // Land on a different phase of both animations every time.
      await page.waitForTimeout(120 + attempt * 173)
      const result = await waitForResult(runId)
      verdicts.push({ status: result.status, changed: result.diff?.changed, ratio: result.diff?.changedRatio })
    }

    expect(verdicts).toEqual([
      { status: 'ok', changed: false, ratio: 0 },
      { status: 'ok', changed: false, ratio: 0 },
      { status: 'ok', changed: false, ratio: 0 },
      { status: 'ok', changed: false, ratio: 0 }
    ])
  }, 60_000)

  it('still sees a real change on that same animated page', async () => {
    const runId = 'anim_real_change'
    const url = new URL(operationUrl('diff', 'animated', runId))
    url.searchParams.set('motion', 'css')
    url.searchParams.set('variant', 'changed')
    await page.goto(url.href, { waitUntil: 'load' })

    const result = await waitForResult(runId)

    expect(result.status).toBe('ok')
    expect(result.diff.changed).toBe(true)
    expect(result.diff.changedRatio).toBeGreaterThan(0.05)
  }, 30_000)

  it('runs the whole handshake from one CLI command', async () => {
    const capture = await runCli(['capture', 'cli-dashboard', '--target', '#target'])
    expect(capture.code).toBe(0)
    expect(JSON.parse(capture.stdout)).toMatchObject({
      status: 'ok',
      operation: 'capture',
      name: 'cli-dashboard'
    })
    // stdout carries the result and nothing else, so `| jq` works.
    expect(capture.stdout.trimStart().startsWith('{')).toBe(true)

    const unchanged = await runCli(['diff', 'cli-dashboard', '--target', '#target', '--fail-on-change'])
    expect(unchanged.code).toBe(0)
    expect(JSON.parse(unchanged.stdout).diff).toMatchObject({ changed: false })

    const changed = await runCli([
      'diff', 'cli-dashboard', '--target', '#target', '--fail-on-change'
    ], { query: { variant: 'changed' } })
    expect(changed.code).toBe(3)
    expect(JSON.parse(changed.stdout).diff.changed).toBe(true)

    const missing = await runCli(['diff', 'cli-never-captured', '--target', '#target'])
    expect(missing.code).toBe(1)
    expect(JSON.parse(missing.stdout).error.code).toBe('BASELINE_NOT_FOUND')
  }, 60_000)

  it('tells the agent the environment is broken instead of hanging', async () => {
    const noServer = await runCli(['diff', 'anything'], { url: 'http://127.0.0.1:1', navigate: false })
    expect(noServer.code).toBe(2)
    expect(noServer.stdout).toBe('')
    expect(noServer.stderr).toContain('not answering')

    const neverOpened = await runCli(['capture', 'cli-timeout', '--timeout', '900'], { navigate: false })
    expect(neverOpened.code).toBe(2)
    expect(neverOpened.stderr).toContain('Timed out')
  }, 30_000)

  it('restart is idempotent and prunes only run directories', async () => {
    const before = await readFile(join(artifactRoot, '.gitignore'), 'utf8')
    await server.close()
    server = await startServer(artifactRoot)
    baseUrl = server.resolvedUrls.local[0]

    expect(await readFile(join(artifactRoot, '.gitignore'), 'utf8')).toBe(before)
    expect((await readdir(join(artifactRoot, 'runs'))).length).toBe(3)
    expect(await readFile(join(artifactRoot, 'baselines', 'keep.txt'), 'utf8')).toBe('baseline sentinel')
    await expectFile(join(artifactRoot, 'baselines', 'dashboard.png'))
  }, 20_000)

  it('tells the developer when no agent will ever be told', async () => {
    // Silent failure otherwise: the agent does the task, verifies nothing, and
    // reports that it looks fine.
    const projectRoot = await mkdtemp(join(tmpdir(), 'snapeye-agentdoc-'))
    await writeFile(join(projectRoot, 'index.html'), '<!doctype html><div id="target">x</div>')
    const startWithLogger = async () => {
      const lines = []
      const server = await createServer({
        root: projectRoot,
        logLevel: 'info',
        customLogger: { ...console, info: line => lines.push(line), warn: () => {}, error: () => {}, warnOnce: () => {}, clearScreen: () => {}, hasErrorLogged: () => false, hasWarned: false },
        plugins: [snapeye({ root: join(projectRoot, '.snapeye') })],
        server: { host: '127.0.0.1', port: 0 }
      })
      await server.listen()
      await server.close()
      return lines.join('\n')
    }

    expect(await startWithLogger()).toContain('npx snapeye init')

    await writeFile(join(projectRoot, 'AGENTS.md'), '# Rules\n\nUse `npx snapeye diff` to verify.\n')
    expect(await startWithLogger()).not.toContain('npx snapeye init')

    await rm(projectRoot, { recursive: true, force: true })
  }, 30_000)

  it('does not inject or create artifacts in production builds', async () => {
    const outDir = join(temporaryRoot, 'dist')
    const productionArtifacts = join(temporaryRoot, 'production-artifacts')
    await build({
      root: fixtureRoot,
      logLevel: 'silent',
      plugins: [snapeye({ root: productionArtifacts })],
      build: { outDir, emptyOutDir: true }
    })
    const html = await readFile(join(outDir, 'index.html'), 'utf8')
    expect(html).not.toContain('data-snapeye-client')
    expect(html).not.toContain('virtual:@zumer/snapeye/client')
    await expect(access(productionArtifacts)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  function operationUrl (operation, name, runId) {
    const url = new URL(baseUrl)
    url.searchParams.set('__snapeye', operation)
    url.searchParams.set('name', name)
    url.searchParams.set('run', runId)
    url.searchParams.set('target', '#target')
    return url.href
  }

  /**
   * Runs the real CLI with `--no-open`: it prints the trigger URL and polls for
   * the terminal result, and this drives that URL with the browser already
   * open. Exercises the exact code path an agent runs from Bash.
   */
  async function runCli (args, { url = baseUrl, navigate = true, query } = {}) {
    const target = new URL(url)
    for (const [key, value] of Object.entries(query || {})) target.searchParams.set(key, value)

    const child = spawn(process.execPath, [
      join(here, '..', '..', 'src', 'cli.js'),
      ...args,
      '--url', target.href,
      '--no-open'
    ], { cwd: temporaryRoot })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })

    if (navigate) {
      const triggerUrl = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`CLI printed no trigger URL: ${stderr}`)), 10_000)
        const check = () => {
          const match = stderr.match(/(https?:\/\/\S+__snapeye=\S+)/)
          if (match) {
            clearTimeout(timer)
            resolve(match[1])
          }
        }
        child.stderr.on('data', check)
        check()
      })
      await page.goto(triggerUrl, { waitUntil: 'load' })
    }

    const code = await new Promise(resolve => child.on('close', resolve))
    return { code, stdout, stderr }
  }

  async function waitForResult (runId, timeout = 20_000) {
    const file = join(artifactRoot, 'runs', runId, 'result.json')
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      try {
        return JSON.parse(await readFile(file, 'utf8'))
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`Timed out waiting for ${file}`)
  }
})

async function startServer (artifactRoot) {
  const vite = await createServer({
    root: fixtureRoot,
    logLevel: 'silent',
    plugins: [snapeye({ root: artifactRoot, maxRuns: 3 })],
    server: { host: '127.0.0.1', port: 0, strictPort: false }
  })
  await vite.listen()
  return vite
}

async function seedOldRuns (artifactRoot) {
  await mkdir(join(artifactRoot, 'baselines'), { recursive: true })
  await mkdir(join(artifactRoot, 'runs'), { recursive: true })
  await writeFile(join(artifactRoot, 'baselines', 'keep.txt'), 'baseline sentinel')
  await writeFile(join(artifactRoot, '.gitignore'), 'custom-entry\nruns/\n')
  for (let index = 0; index < 5; index++) {
    const run = join(artifactRoot, 'runs', `old_${index}`)
    await mkdir(run)
    await writeFile(join(run, 'result.json'), JSON.stringify({
      finishedAt: new Date(Date.UTC(2020, 0, index + 1)).toISOString()
    }))
  }
}

async function expectFile (path) {
  expect((await stat(path)).isFile()).toBe(true)
  expect((await stat(path)).size).toBeGreaterThan(0)
}

function findChrome () {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean)
  return candidates.find(candidate => existsSync(candidate)) || null
}
