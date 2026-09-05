import { afterEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../../src/cli.js', import.meta.url))
const cleanup = []

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

describe('CLI handshake failures', () => {
  it.each(['headers', 'body'])('bounds a health request stalled at its %s', async stage => {
    const { url } = await startServer((req, res) => {
      if (stage === 'body') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.write('{"status":')
      }
    })

    const result = await runCli(url, ['--timeout', '100'])
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('health check timed out')
  })

  it('refuses an existing run before printing a trigger or accepting its stale success', async () => {
    const { url, root } = await startServer()
    await publish(root, successfulResult())

    const result = await runCli(url)
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('already exists')
    expect(result.stderr).not.toContain('__snapeye=')
  })

  it.each([
    { label: 'a different run', data: successfulResult({ runId: 'wrong' }) },
    { label: 'a different operation', data: successfulResult({ operation: 'capture' }) },
    { label: 'a different baseline', data: successfulResult({ name: 'wrong' }) },
    { label: 'invalid JSON', data: '{' }
  ])('reports $label as an environment error, never a successful comparison', async ({ data }) => {
    const { url, root } = await startServer()
    const result = await runCli(url, [], () => publish(root, data))
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('Could not read the terminal result')
    expect(result.stderr).not.toContain('at async')
  })

  it('keeps the documented exit code and JSON for a new successful diff', async () => {
    const { url, root } = await startServer()
    const data = successfulResult({ diff: { changed: true } })
    const result = await runCli(url, ['--fail-on-change'], () => publish(root, data))
    expect(result.code).toBe(3)
    expect(JSON.parse(result.stdout)).toEqual(data)
  })
})

function successfulResult (overrides = {}) {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    runId: 'cli_run',
    status: 'ok',
    operation: 'diff',
    name: 'panel',
    diff: { changed: false },
    ...overrides
  }
}

async function publish (root, data) {
  const run = join(root, 'runs', 'cli_run')
  await mkdir(run, { recursive: true })
  await writeFile(join(run, 'result.tmp'), typeof data === 'string' ? data : JSON.stringify(data))
  await rename(join(run, 'result.tmp'), join(run, 'result.json'))
}

async function startServer (handler) {
  const root = await mkdtemp(join(tmpdir(), 'snapeye-cli-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const server = createServer(handler || ((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ status: 'ok', protocolVersion: 1, artifactRootResolved: root }))
  }))
  cleanup.push(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { root, url: `http://127.0.0.1:${server.address().port}` }
}

function runCli (url, args = [], onTrigger) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      cli, 'diff', 'panel', '--run', 'cli_run', '--url', url, '--no-open', ...args
    ])
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`CLI failed to exit within 3s: ${stderr}`))
    }, 3000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => {
      stderr += chunk
      if (onTrigger && /__snapeye=/.test(stderr)) {
        const publish = onTrigger
        onTrigger = null
        publish().catch(error => { child.kill(); reject(error) })
      }
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}
