import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapeye } from '../../src/vite.js'

const CLIENT_ID = 'virtual:@zumer/snapeye/client'
const RESOLVED_CLIENT_ID = `\0${CLIENT_ID}`
const temporaryRoots = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('snapeye() Vite plugin options', () => {
  it('only applies to the dev server and resolves its virtual client', () => {
    const plugin = snapeye()

    expect(plugin.name).toBe('@zumer/snapeye')
    expect(plugin.apply).toBe('serve')
    expect(plugin.resolveId(CLIENT_ID)).toBe(RESOLVED_CLIENT_ID)
    expect(plugin.resolveId('some/other/module')).toBeNull()
  })

  it('injects a client that changes nothing about the application by default', () => {
    expect(clientConfig(snapeye())).toEqual({
      forwardConsole: false,
      errorOverlay: false,
      hotkey: false
    })
  })

  it('passes explicit client opt-ins through to the injected runtime', () => {
    expect(clientConfig(snapeye({
      client: { forwardConsole: true, errorOverlay: true, hotkey: 'k' }
    }))).toEqual({
      forwardConsole: true,
      errorOverlay: true,
      hotkey: 'k',
      hotkeyName: 'current'
    })

    expect(clientConfig(snapeye({
      client: { hotkey: 'S', hotkeyName: 'scratch' }
    }))).toMatchObject({ hotkey: 'S', hotkeyName: 'scratch' })
  })

  it('never leaks the ephemeral token into two plugin instances alike', () => {
    const first = injectedSource(snapeye())
    const second = injectedSource(snapeye())
    const tokenOf = source => source.match(/const token = "([^"]+)"/)[1]

    expect(tokenOf(first)).not.toBe(tokenOf(second))
    expect(tokenOf(first).length).toBeGreaterThanOrEqual(32)
  })

  it.each([
    { label: 'an unknown option', options: { maxRun: 5 } },
    { label: 'an unknown client option', options: { client: { verbose: true } } },
    { label: 'a non-object client', options: { client: 'yes' } },
    { label: 'a non-boolean toggle', options: { client: { forwardConsole: 'yes' } } },
    { label: 'a multi-character hotkey', options: { client: { hotkey: 'Shift' } } },
    { label: 'an unsafe hotkey baseline name', options: { client: { hotkeyName: '../escape' } } },
    { label: 'an empty root', options: { root: '   ' } },
    { label: 'a negative maxRuns', options: { maxRuns: -1 } }
  ])('rejects $label instead of ignoring it', ({ options }) => {
    expect(() => snapeye(options)).toThrow(TypeError)
  })

  it('declares the injected client dependencies for pre-bundling', () => {
    // The scanner crawls the HTML entry, so bare imports reachable only from
    // the virtual client are never discovered up front. Without this the first
    // page load can receive gifenc's raw CommonJS build and the client dies
    // with "exports is not defined" before window.snapeye exists.
    const config = snapeye().config({ root: 'test/fixtures/vite-app' })

    expect(config.optimizeDeps.include).toEqual([
      '@zumer/snapdom',
      '@zumer/snapdiff/diff',
      'gifenc'
    ])
  })

  it('leaves out dependencies the host project cannot resolve', () => {
    const config = snapeye().config({ root: '/definitely/not/a/project' })

    expect(config).toBeNull()
  })

  it('pre-bundles private dependencies in an isolated package installation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snapeye-prebundle-'))
    temporaryRoots.push(root)
    const installed = join(root, 'packages', 'snapeye')
    const modules = join(root, 'app', 'node_modules', '@zumer')
    await mkdir(installed, { recursive: true })
    await mkdir(modules, { recursive: true })
    // Like pnpm, the app links to SnapEye while its dependencies live beside
    // the real package. package.json is deliberately absent from its exports.
    await writeFile(join(installed, 'package.json'), JSON.stringify({
      name: '@zumer/snapeye', type: 'module', exports: { '.': { import: './index.js' } }
    }))
    await symlink(installed, join(modules, 'snapeye'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const dependency of ['@zumer/snapdom', '@zumer/snapdiff', 'gifenc']) {
      const directory = join(root, 'packages', 'node_modules', dependency)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'package.json'), JSON.stringify({
        name: dependency, exports: { '.': './index.js', './diff': './index.js' }
      }))
      await writeFile(join(directory, 'index.js'), '')
    }

    const config = snapeye().config({ root: join(root, 'app') })
    expect(config?.optimizeDeps.include).toEqual([
      '@zumer/snapeye > @zumer/snapdom',
      '@zumer/snapeye > @zumer/snapdiff/diff',
      '@zumer/snapeye > gifenc'
    ])
  })

  it('injects the client tag once per document', () => {
    const plugin = snapeye()
    const inject = plugin.transformIndexHtml.handler

    const tags = inject('<html><head></head><body></body></html>')
    expect(tags).toHaveLength(1)
    expect(tags[0]).toMatchObject({
      tag: 'script',
      injectTo: 'head-prepend',
      attrs: { type: 'module', 'data-snapeye-client': '' }
    })
    expect(tags[0].attrs.src).toContain(CLIENT_ID)
    expect(inject('<script data-snapeye-client src="/@id/x"></script>')).toBeNull()
  })
})

function injectedSource (plugin) {
  return plugin.load(RESOLVED_CLIENT_ID)
}

function clientConfig (plugin) {
  const source = injectedSource(plugin)
  return JSON.parse(source.match(/^const client = (.+)$/m)[1])
}
