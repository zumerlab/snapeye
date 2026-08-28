import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureGitignore } from '../../src/node/gitignore.js'

describe('.snapeye/.gitignore maintenance', () => {
  let sandbox
  let root
  let path

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'snapeye-gitignore-'))
    root = join(sandbox, '.snapeye')
    path = join(root, '.gitignore')
  })

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true })
  })

  it('creates only disposable-run entries and leaves baselines trackable', async () => {
    const result = await ensureGitignore(root)
    const content = await readFile(path, 'utf8')

    expect(result).toMatchObject({ created: true, added: ['runs/', '*.tmp'] })
    expect(content).toContain('runs/\n')
    expect(content).toContain('*.tmp\n')
    expect(content).not.toContain('baselines/')
  })

  it('appends only missing entries without rewriting user content', async () => {
    await mkdir(root)
    const original = '# user rule\ncustom/**'
    await writeFile(path, original)

    const result = await ensureGitignore(root)

    expect(result).toMatchObject({ created: false, added: ['runs/', '*.tmp'] })
    expect(await readFile(path, 'utf8')).toBe(`${original}\nruns/\n*.tmp\n`)
  })

  it('preserves existing line endings/content and adds only the absent rule', async () => {
    await mkdir(root)
    const original = '# mine\r\nruns/\r\n'
    await writeFile(path, original)

    const result = await ensureGitignore(root)

    expect(result.added).toEqual(['*.tmp'])
    expect(await readFile(path, 'utf8')).toBe(`${original}*.tmp\n`)
  })

  it('is byte-for-byte idempotent once required entries exist', async () => {
    await mkdir(root)
    const original = '# mine\nruns/\n*.tmp\ncustom/\n'
    await writeFile(path, original)

    const first = await ensureGitignore(root)
    const second = await ensureGitignore(root)

    expect(first.added).toEqual([])
    expect(second.added).toEqual([])
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it.skipIf(process.platform === 'win32')('refuses a symlinked .gitignore without changing its target', async () => {
    const outside = join(sandbox, 'outside-ignore')
    await mkdir(root)
    await writeFile(outside, '# outside\n')
    await symlink(outside, path)

    await expect(ensureGitignore(root)).rejects.toMatchObject({ code: 'INVALID_PATH' })
    expect(await readFile(outside, 'utf8')).toBe('# outside\n')
  })
})
