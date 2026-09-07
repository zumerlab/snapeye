import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { resolveSnapdomBuild, startStandaloneServer } from '../../src/node/standalone.js'

const require = createRequire(import.meta.url)
// The installed package stands in for "a local build": it has the same
// dist/snapdom.mjs + dist/snapdom.js pair a checkout produces.
const snapdomDist = dirname(require.resolve('@zumer/snapdom'))
const snapdomPackage = dirname(snapdomDist)

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>issue</title>
<script src="https://unpkg.com/@zumer/snapdom/dist/snapdom.js"></script>
<script type="module" src="https://cdn.jsdelivr.net/npm/@zumer/snapdom@2.24.15/dist/snapdom.mjs"></script>
</head><body><div id="test">hello</div></body></html>`

const cleanup = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

describe('standalone server', () => {
  it('serves a lone HTML file with the client injected and no node_modules in sight', async () => {
    const { dir } = await scratch({ 'issue.html': PAGE })
    const server = await startStandaloneServer({ entry: join(dir, 'issue.html'), root: join(dir, 'artifacts') })
    cleanup.push(() => server.close())

    expect(server.url).toBe(`${server.origin}/issue.html`)
    expect(server.artifactRoot).toBe(join(dir, 'artifacts'))
    expect(server.snapdom).toBeNull()

    const health = await (await fetch(`${server.origin}/__snapeye/health`)).json()
    expect(health).toMatchObject({ status: 'ok', protocolVersion: 1, artifactRootResolved: join(dir, 'artifacts') })

    const html = await (await fetch(server.url, { headers: { accept: 'text/html' } })).text()
    expect(html).toContain('data-snapeye-client')
    // Without --snapdom the page keeps loading SnapDOM from the CDN.
    expect(html).toContain('https://unpkg.com/@zumer/snapdom/dist/snapdom.js')

    // The client's bare imports resolve to files even though the page's
    // directory has no node_modules: that is what makes a scratch page work.
    const client = await (await fetch(`${server.origin}/@id/virtual:@zumer/snapeye/client`)).text()
    expect(client).toMatch(/from "\/@fs\/.*\/@zumer\/snapdom\/dist\/snapdom\.mjs"/)
    const runtime = await (await fetch(`${server.origin}/@fs${join(dirname(require.resolve('../../src/client.js')), 'client', 'runtime.js')}`)).text()
    expect(runtime).toMatch(/from "\/@fs\/.*\/@zumer\/snapdiff\/src\/diff\.js"/)
    const encoders = await (await fetch(`${server.origin}/@fs${join(dirname(require.resolve('../../src/client.js')), 'client', 'encoders.js')}`)).text()
    expect(encoders).toMatch(/from "\/@fs\/.*\/gifenc\/dist\/gifenc\.esm\.js"/)
  })

  it('points both the client and the page at a local SnapDOM build', async () => {
    const { dir } = await scratch({ 'issue.html': PAGE })
    const server = await startStandaloneServer({ entry: join(dir, 'issue.html'), snapdom: snapdomDist, root: join(dir, 'artifacts') })
    cleanup.push(() => server.close())

    expect(server.snapdom).toEqual({ dir: snapdomDist, esm: join(snapdomDist, 'snapdom.mjs'), iife: join(snapdomDist, 'snapdom.js') })

    const html = await (await fetch(server.url, { headers: { accept: 'text/html' } })).text()
    expect(html).not.toContain('unpkg.com')
    expect(html).not.toContain('jsdelivr.net')
    expect(html).toContain(`src="/@fs${join(snapdomDist, 'snapdom.js')}"`)
    expect(html).toContain(`src="/@fs${join(snapdomDist, 'snapdom.mjs')}"`)

    const client = await (await fetch(`${server.origin}/@id/virtual:@zumer/snapeye/client`)).text()
    expect(client).toContain(`from "/@fs${join(snapdomDist, 'snapdom.mjs')}"`)
    // And Vite actually serves the file it was pointed at.
    const served = await fetch(`${server.origin}/@fs${join(snapdomDist, 'snapdom.mjs')}`)
    expect(served.status).toBe(200)
    expect(await served.text()).toContain('snapdom')
  })

  it('serves a directory at its index and refuses what it cannot serve', async () => {
    const { dir } = await scratch({ 'index.html': PAGE, 'notes.txt': 'not a page' })
    const server = await startStandaloneServer({ entry: dir, root: join(dir, 'artifacts') })
    cleanup.push(() => server.close())
    expect(server.url).toBe(`${server.origin}/`)
    const html = await (await fetch(server.url, { headers: { accept: 'text/html' } })).text()
    expect(html).toContain('data-snapeye-client')

    await expect(startStandaloneServer({ entry: join(dir, 'missing.html') })).rejects.toThrow(/Nothing to serve/)
    await expect(startStandaloneServer({ entry: join(dir, 'notes.txt') })).rejects.toThrow(/Expected an \.html file/)
    await expect(startStandaloneServer({ entry: '' })).rejects.toThrow(/required/)
  })

  it('finds both faces of a SnapDOM build from a directory, a package root, or either file', async () => {
    const expected = { dir: snapdomDist, esm: join(snapdomDist, 'snapdom.mjs'), iife: join(snapdomDist, 'snapdom.js') }
    expect(await resolveSnapdomBuild(snapdomDist)).toEqual(expected)
    expect(await resolveSnapdomBuild(snapdomPackage)).toEqual(expected)
    expect(await resolveSnapdomBuild(join(snapdomDist, 'snapdom.mjs'))).toEqual(expected)
    expect(await resolveSnapdomBuild(join(snapdomDist, 'snapdom.js'))).toEqual(expected)

    const { dir } = await scratch({ 'snapdom.js': '/* iife only */' })
    await expect(resolveSnapdomBuild(join(dir, 'snapdom.js'))).rejects.toThrow(/No ESM SnapDOM build/)
    await expect(resolveSnapdomBuild(join(dir, 'nope'))).rejects.toThrow(/not found/)
  })
})

async function scratch (files) {
  const dir = await mkdtemp(join(tmpdir(), 'snapeye-standalone-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  await mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content)
  return { dir }
}
