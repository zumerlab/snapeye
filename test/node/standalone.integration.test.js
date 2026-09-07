import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startStandaloneServer } from '../../src/node/standalone.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = join(here, '..', 'fixtures', 'vite-app')
const require = createRequire(import.meta.url)
// The installed package plays the part of a local checkout's build.
const localBuild = dirname(require.resolve('@zumer/snapdom'))
const chromePath = findChrome()
const browserRequired = process.env.SNAPEYE_REQUIRE_BROWSER === '1' || process.env.CI === 'true'

if (!chromePath) {
  console.warn('\n[snapeye] standalone integration tests SKIPPED: no Chrome/Chromium executable found.\n')
}

describe.runIf(browserRequired)('standalone integration prerequisites', () => {
  it('finds the browser the integration suite requires', () => {
    expect(chromePath, 'No Chrome/Chromium found. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.').toBeTruthy()
  })
})

describe.skipIf(!chromePath).sequential('standalone integration', () => {
  let temporaryRoot
  let pageDir
  let artifactRoot
  let server
  let browser
  let page

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'snapeye-standalone-it-'))
    // A copy of the fixture in a directory with no node_modules anywhere above
    // it: the situation an issue repro is in.
    pageDir = join(temporaryRoot, 'page')
    await cp(fixtureRoot, pageDir, { recursive: true })
    artifactRoot = join(temporaryRoot, '.snapeye')
    server = await startStandaloneServer({ entry: join(pageDir, 'index.html'), snapdom: localBuild, root: artifactRoot })
    browser = await chromium.launch({ headless: true, executablePath: chromePath, args: ['--no-sandbox'] })
    page = await browser.newPage()
  }, 30_000)

  afterAll(async () => {
    await page?.close().catch(() => {})
    await browser?.close().catch(() => {})
    await server?.close().catch(() => {})
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
  })

  it('captures through the URL protocol with the client resolved from SnapEye, not the page', async () => {
    const trigger = new URL(server.url)
    trigger.searchParams.set('__snapeye', 'capture')
    trigger.searchParams.set('name', 'standalone')
    trigger.searchParams.set('run', 'standalone_capture')
    trigger.searchParams.set('target', '#target')
    trigger.searchParams.set('snapdomOptions', JSON.stringify({ scale: 2 }))
    await page.goto(trigger.href, { waitUntil: 'load' })
    expect(await page.evaluate(() => typeof window.snapeye)).toBe('object')

    const result = await waitForResult('standalone_capture')
    expect(result).toMatchObject({
      status: 'ok',
      operation: 'capture',
      name: 'standalone',
      image: { cssWidth: 320, cssHeight: 180, pixelWidth: 640, pixelHeight: 360, scale: 2 },
      artifacts: { baseline: '../../baselines/standalone.png', svg: 'current.svg' }
    })
    expect(result.timing.captureMs).toBeGreaterThanOrEqual(0)
    expect(await readFile(join(artifactRoot, 'runs', 'standalone_capture', 'current.svg'), 'utf8')).toMatch(/^\s*<svg/)
    expect((await readdir(join(artifactRoot, 'baselines'))).sort()).toEqual(['standalone.json', 'standalone.png'])
  }, 30_000)

  it('runs one CLI command that hosts the page itself with --serve and a local SnapDOM build', async () => {
    const child = spawn(process.execPath, [
      join(here, '..', '..', 'src', 'cli.js'),
      'capture', 'cli-standalone',
      '--serve', join(pageDir, 'index.html'),
      '--snapdom', localBuild,
      '--target', '#target',
      '--root', artifactRoot,
      '--no-open'
    ], { cwd: temporaryRoot })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })

    const triggerUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CLI printed no trigger URL: ${stderr}`)), 15_000)
      const check = () => {
        const match = stderr.match(/(https?:\/\/\S+__snapeye=\S+)/)
        if (match) { clearTimeout(timer); resolve(match[1]) }
      }
      child.stderr.on('data', check)
      check()
    })
    // The CLI's own server, on its own port, not the one from beforeAll.
    expect(new URL(triggerUrl).origin).not.toBe(server.origin)
    await page.goto(triggerUrl, { waitUntil: 'load' })

    const code = await new Promise(resolve => child.on('close', resolve))
    expect(code, stderr).toBe(0)
    const result = JSON.parse(stdout)
    expect(result).toMatchObject({ status: 'ok', operation: 'capture', name: 'cli-standalone' })
    expect(result.artifacts.svg).toBe('current.svg')
    expect(stderr).toContain('serving http://127.0.0.1:')

    // The server the CLI started is gone with the run.
    await expect(fetch(new URL('/__snapeye/health', triggerUrl))).rejects.toThrow()
  }, 40_000)

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
