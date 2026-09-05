// Install the actual tarball into a fresh app and drive its installed CLI/client.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
// macOS exposes tmpdir through /var -> /private/var. Use one canonical Vite
// root so transformed module ids and its filesystem allow-list agree.
const work = realpathSync(mkdtempSync(join(tmpdir(), 'snapeye-packed-')))
const core = process.env.SNAPDOM_PACKAGE_PATH
  ? resolve(process.env.SNAPDOM_PACKAGE_PATH) : `@zumer/snapdom@${pkg.devDependencies['@zumer/snapdom']}`
let browser, server, succeeded = false
const children = new Set()

function run(command, args, cwd = work) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  return result.stdout.trim()
}

try {
  const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], root))[0]
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'snapeye-consumer', private: true, type: 'module' }))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund',
    ...(process.env.SNAPEYE_PACK_OFFLINE === '1' ? ['--offline'] : []),
    join(work, packed.filename), core, `vite@${pkg.devDependencies.vite}`, `@types/node@${pkg.devDependencies['@types/node']}`])
  const installedCore = JSON.parse(readFileSync(join(work, 'node_modules/@zumer/snapdom/package.json'), 'utf8'))
  const installedDiff = JSON.parse(readFileSync(join(work, 'node_modules/@zumer/snapdiff/package.json'), 'utf8'))
  console.log(`Packed consumer: SnapDOM ${installedCore.version}; snapDiff ${installedDiff.version}; ${work}`)
  if (process.env.SNAPDOM_EXPECTED_MAJOR) {
    assert.equal(Number.parseInt(installedCore.version, 10), Number(process.env.SNAPDOM_EXPECTED_MAJOR))
  }

  writeFileSync(join(work, 'index.ts'), `
import { snapdom } from '@zumer/snapdom'
import { attachSnapEye, type ArtifactStore, type SnapEyeResult } from '@zumer/snapeye/client'
import { snapeye } from '@zumer/snapeye/vite'
declare const store: ArtifactStore
const api = attachSnapEye({ snapdom, store })
const capture: Promise<SnapEyeResult> = api.capture('card', '#card', { snapdomOptions: { plugins: [] } })
void api.diff('card', '#card')
void api.record('card', '#card', { duration: 800, fps: 5 })
void capture
void snapeye()
`)
  run(join(root, 'node_modules/.bin/tsc'), ['--noEmit', '--strict', '--skipLibCheck', 'false',
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'index.ts'])

  writeFileSync(join(work, 'AGENTS.md'), '# Fixture\nSnapEye capture/diff/record packed consumer smoke.\n')
  writeFileSync(join(work, 'index.html'), `<!doctype html><html><head><style>
body { margin:0 } #card { width:120px;height:80px;background:#2375bf;color:white }
</style></head><body><div id="card">Packed consumer</div><script type="module" src="/main.js"></script></body></html>`)
  writeFileSync(join(work, 'main.js'), `
import { snapdom } from '@zumer/snapdom'
window.snapdomVersion = snapdom.version
if (new URLSearchParams(location.search).has('changed')) document.querySelector('#card').style.background = 'red'
`)
  const { createServer } = await import(pathToFileURL(join(work, 'node_modules/vite/dist/node/index.js')))
  const { snapeye } = await import(pathToFileURL(join(work, 'node_modules/@zumer/snapeye/src/vite.js')))
  server = await createServer({
    root: work, logLevel: 'error', plugins: [snapeye()],
    server: { host: '127.0.0.1', port: 0 }
  })
  await server.listen()
  const url = server.resolvedUrls.local[0]
  const html = await (await fetch(url, { headers: { Accept: 'text/html' } })).text()
  assert.match(html, /data-snapeye-client/)
  const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', chromium.executablePath()].filter(Boolean).find(existsSync)
  if (!executablePath) throw new Error('Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to run the packed consumer smoke')
  browser = await chromium.launch({ headless: true, executablePath })
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))

  async function cli(args, query = '') {
    const child = spawn(process.execPath, [join(work, 'node_modules/@zumer/snapeye/src/cli.js'),
      ...args, '--target', '#card', '--url', `${url}${query}`, '--no-open', '--timeout', '20000'], { cwd: work })
    children.add(child)
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const completed = new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', code => { children.delete(child); resolve(code) })
    })
    const trigger = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CLI printed no URL: ${stderr}`)), 10000)
      const check = () => {
        const match = stderr.match(/(https?:\/\/\S+__snapeye=\S+)/)
        if (match) { clearTimeout(timer); resolve(match[1]) }
      }
      child.stderr.on('data', check)
      child.on('error', error => { clearTimeout(timer); reject(error) })
      check()
    })
    await page.goto(trigger, { waitUntil: 'load' })
    assert.equal(await completed, 0, stderr)
    const result = JSON.parse(stdout)
    assert.equal(result.status, 'ok', stdout)
    assert.equal(pageErrors.length, 0, pageErrors.join('\n'))
    return result
  }

  await cli(['capture', 'card'])
  const same = await cli(['diff', 'card', '--fail-on-change'])
  assert.equal(same.diff.changed, false)
  const changed = await cli(['diff', 'card'], '?changed=1')
  assert.equal(changed.diff.changed, true)
  const recording = await cli(['record', 'card', '--duration', '800', '--fps', '5'])
  assert.ok(recording.record.frameCount > 1)
  for (const name of ['frames', 'gif']) {
    assert.ok(readFileSync(join(work, '.snapeye/runs', recording.runId, recording.artifacts[name])).length > 0)
  }
  console.log('PASS: installed types, injection, CLI capture, unchanged/changed diff, recording and artifacts')
  succeeded = true
} finally {
  for (const child of children) child.kill()
  await browser?.close()
  await server?.close()
  if (succeeded && process.env.SNAPEYE_KEEP_PACK !== '1') rmSync(work, { recursive: true, force: true })
  else console.log(`Packed consumer retained at ${work}`)
}
