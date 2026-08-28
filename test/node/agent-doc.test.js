import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_BLOCK, ensureAgentDoc, hasAgentDoc } from '../../src/node/agent-doc.js'

describe('agent instructions', () => {
  let root

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'snapeye-agentdoc-'))
  })

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('creates AGENTS.md when the project has no agent instructions', async () => {
    const results = await ensureAgentDoc(root)

    expect(results).toEqual([{ path: join(root, 'AGENTS.md'), action: 'created' }])
    const content = await readFile(join(root, 'AGENTS.md'), 'utf8')
    expect(content).toBe(`${AGENT_BLOCK}\n`)
    // The discipline is the part an agent cannot infer from the tool existing.
    expect(content).toContain('Capture the baseline BEFORE editing')
    expect(content).toContain('Never re-capture a baseline just to make a diff pass')
  })

  it('appends to every existing instructions file without touching what is there', async () => {
    const existing = '# House rules\n\nRun the tests before pushing.\n'
    await writeFile(join(root, 'AGENTS.md'), existing)
    await writeFile(join(root, 'CLAUDE.md'), existing)

    const results = await ensureAgentDoc(root)

    expect(results.map(result => result.action)).toEqual(['appended', 'appended'])
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const content = await readFile(join(root, name), 'utf8')
      expect(content.startsWith(existing)).toBe(true)
      expect(content).toContain(AGENT_BLOCK)
    }
  })

  it('is idempotent', async () => {
    await ensureAgentDoc(root)
    const first = await readFile(join(root, 'AGENTS.md'), 'utf8')

    const results = await ensureAgentDoc(root)

    expect(results[0].action).toBe('unchanged')
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(first)
  })

  it('refreshes only the delimited block when the instructions change', async () => {
    await writeFile(
      join(root, 'AGENTS.md'),
      `# House rules\n\n<!-- snapeye:begin -->\nstale instructions\n<!-- snapeye:end -->\n\nKeep this trailing note.\n`
    )

    const results = await ensureAgentDoc(root)

    const content = await readFile(join(root, 'AGENTS.md'), 'utf8')
    expect(results[0].action).toBe('updated')
    expect(content).toContain('# House rules')
    expect(content).toContain('Keep this trailing note.')
    expect(content).toContain(AGENT_BLOCK)
    expect(content).not.toContain('stale instructions')
  })

  it('leaves hand-written SnapEye instructions alone instead of duplicating them', async () => {
    const handwritten = '# Rules\n\nUse snapeye diff before every PR.\n'
    await writeFile(join(root, 'AGENTS.md'), handwritten)

    const results = await ensureAgentDoc(root)

    expect(results[0]).toMatchObject({ action: 'skipped' })
    expect(await readFile(join(root, 'AGENTS.md'), 'utf8')).toBe(handwritten)
  })

  it('writes to an explicitly named file', async () => {
    const results = await ensureAgentDoc(root, { file: '.cursorrules' })

    expect(results[0]).toMatchObject({ path: join(root, '.cursorrules'), action: 'created' })
  })

  it('reports whether an agent will be told at all', async () => {
    expect(await hasAgentDoc(root)).toBe(false)
    expect(await hasAgentDoc(join(root, 'missing'))).toBe(false)

    await writeFile(join(root, 'CLAUDE.md'), '# Rules\n\nNothing visual here.\n')
    expect(await hasAgentDoc(root)).toBe(false)

    await ensureAgentDoc(root, { file: 'CLAUDE.md' })
    expect(await hasAgentDoc(root)).toBe(true)
  })
})
