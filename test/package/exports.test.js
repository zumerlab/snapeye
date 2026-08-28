import { describe, expect, it } from 'vitest'
import { readFile, readdir, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))

describe('package contract', () => {
  it('serves the browser a client-only entry so bundlers never pull node builtins', () => {
    expect(packageJson.exports['.'].browser).toEqual({
      types: './types/client.d.ts',
      import: './src/client.js'
    })
    // Node keeps the full entry; the condition order decides which one wins.
    expect(Object.keys(packageJson.exports['.'])[0]).toBe('browser')
    expect(packageJson.exports['.'].import).toBe('./src/index.js')
  })

  it('keeps every published entry point on disk', async () => {
    const targets = Object.values(packageJson.exports)
      .flatMap(entry => Object.values(entry))
      .flatMap(value => typeof value === 'string' ? [value] : Object.values(value))

    expect(targets.length).toBeGreaterThan(0)
    for (const target of targets) {
      await expect(access(join(repoRoot, target)), `missing ${target}`).resolves.toBeUndefined()
    }
  })

  it('never takes a default import from a dual CommonJS/ESM dependency', async () => {
    // gifenc ships CJS through main/browser and ESM through module with no
    // exports map. A bundler that picks the CommonJS build exposes named
    // exports and NO default, so `import x from 'gifenc'` throws at evaluation
    // time and takes the whole in-page client down. Only a namespace import is
    // safe across resolvers.
    const code = stripComments(await readFile(join(repoRoot, 'src', 'client', 'encoders.js'), 'utf8'))

    expect(code).toMatch(/import \* as \w+ from ['"]gifenc['"]/)
    expect(code).not.toMatch(/import\s+\w+\s+from\s+['"]gifenc['"]/)
  })

  it('keeps the browser-reachable modules free of node-only imports', async () => {
    const browserModules = [
      join(repoRoot, 'src', 'client.js'),
      ...await listModules(join(repoRoot, 'src', 'client')),
      ...await listModules(join(repoRoot, 'src', 'core'))
    ]

    for (const file of browserModules) {
      const source = await readFile(file, 'utf8')
      expect(source, `${file} imports a node builtin`).not.toMatch(/from\s+['"]node:/)
    }
  })
})

/** Prose about an unsafe import is not an unsafe import. */
function stripComments (source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

async function listModules (directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => join(directory, entry.name))
}
