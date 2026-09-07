import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { buildTriggerUrl, parseArgs, resolveArtifactRoot } from '../../src/cli.js'

describe('snapeye CLI arguments', () => {
  it('builds a trigger URL that keeps the page it was pointed at', () => {
    const options = parseArgs([
      'diff', 'dashboard',
      '--url', 'http://localhost:5173/settings?tab=billing',
      '--target', '#dashboard',
      '--run', 'agent_001'
    ])

    const url = new URL(buildTriggerUrl(options))
    expect(url.pathname).toBe('/settings')
    expect(url.searchParams.get('tab')).toBe('billing')
    expect(url.searchParams.get('__snapeye')).toBe('diff')
    expect(url.searchParams.get('name')).toBe('dashboard')
    expect(url.searchParams.get('run')).toBe('agent_001')
    expect(url.searchParams.get('target')).toBe('#dashboard')
    expect(options.origin).toBe('http://localhost:5173')
  })

  it('mints a valid run id when the caller does not supply one', () => {
    const first = parseArgs(['capture', 'dashboard'])
    const second = parseArgs(['capture', 'dashboard'])

    expect(first.runId).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(first.runId).not.toBe(second.runId)
  })

  it('passes record and stability options through to the URL', () => {
    const options = parseArgs([
      'record', 'menu',
      '--duration', '2500', '--fps', '12', '--format', 'both', '--scale', '0.5',
      '--wait', '#ready', '--no-stabilize'
    ])

    const url = new URL(buildTriggerUrl(options))
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      __snapeye: 'record',
      duration: '2500',
      fps: '12',
      format: 'both',
      scale: '0.5',
      wait: '#ready',
      stabilize: '0'
    })
  })

  it('omits stability parameters when the defaults apply', () => {
    const url = new URL(buildTriggerUrl(parseArgs(['capture', 'dashboard'])))

    expect(url.searchParams.has('stabilize')).toBe(false)
    expect(url.searchParams.has('wait')).toBe(false)
    expect(url.searchParams.has('target')).toBe(false)
  })

  it.each([
    { label: 'no operation', argv: [] },
    { label: 'an unknown operation', argv: ['frobnicate', 'x'] },
    { label: 'a missing name', argv: ['diff'] },
    { label: 'an unsafe name', argv: ['diff', '../escape'] },
    { label: 'an unsafe run id', argv: ['diff', 'ok', '--run', '../escape'] },
    { label: 'an unknown flag', argv: ['diff', 'ok', '--wat'] },
    { label: 'a flag without its value', argv: ['diff', 'ok', '--target'] },
    { label: 'a non-numeric timeout', argv: ['diff', 'ok', '--timeout', 'soon'] },
    { label: 'an unparseable url', argv: ['diff', 'ok', '--url', 'not a url'] },
    { label: 'a non-HTTP url', argv: ['diff', 'ok', '--url', 'file:///tmp/index.html'] },
    { label: 'a stray argument', argv: ['diff', 'ok', 'extra'] }
  ])('refuses $label', ({ argv }) => {
    expect(() => parseArgs(argv)).toThrow()
  })

  it('accepts init as a command that needs no name, url, or dev server', () => {
    expect(parseArgs(['init'])).toMatchObject({ command: 'init', file: null })
    expect(parseArgs(['init', '--file', 'CLAUDE.md'])).toMatchObject({
      command: 'init',
      file: 'CLAUDE.md'
    })
    expect(() => parseArgs(['init', 'extra'])).toThrow(/no positional arguments/)
  })

  it('prefers the absolute root the server resolved over the configured one', () => {
    expect(resolveArtifactRoot(null, {
      artifactRoot: '.snapeye',
      artifactRootResolved: '/repo/apps/web/.snapeye'
    })).toBe('/repo/apps/web/.snapeye')
  })

  it('falls back to the configured root, then to the default', () => {
    expect(resolveArtifactRoot(null, { artifactRoot: '.snapeye' }))
      .toBe(resolve(process.cwd(), '.snapeye'))
    expect(resolveArtifactRoot(null, {})).toBe(resolve(process.cwd(), '.snapeye'))
    expect(resolveArtifactRoot('custom-dir', { artifactRootResolved: '/elsewhere' }))
      .toBe(resolve(process.cwd(), 'custom-dir'))
  })
})

describe('snapeye CLI: standalone serving and per-run SnapDOM options', () => {
  it('passes --snapdom-options through to the URL as one JSON parameter', () => {
    const options = parseArgs(['capture', 'fonts', '--snapdom-options', '{"embedFonts":true,"scale":2}'])
    const url = new URL(buildTriggerUrl(options))
    expect(JSON.parse(url.searchParams.get('snapdomOptions'))).toEqual({ embedFonts: true, scale: 2 })
    expect(url.searchParams.has('svg')).toBe(false)
  })

  it.each([
    { label: 'invalid JSON', value: '{embedFonts: true}' },
    { label: 'an array', value: '[1,2]' },
    { label: 'a scalar', value: 'true' }
  ])('refuses --snapdom-options that is $label before opening anything', ({ value }) => {
    expect(() => parseArgs(['capture', 'fonts', '--snapdom-options', value])).toThrow(/--snapdom-options/)
  })

  it('turns --no-svg into svg=0', () => {
    const url = new URL(buildTriggerUrl(parseArgs(['diff', 'fonts', '--no-svg'])))
    expect(url.searchParams.get('svg')).toBe('0')
  })

  it('accepts serve as a command with the page as its argument', () => {
    expect(parseArgs(['serve', 'issue.html'])).toMatchObject({ command: 'serve', entry: 'issue.html', snapdom: null, port: null })
    expect(parseArgs(['serve', 'docs/', '--snapdom', './dist', '--port', '8493']))
      .toMatchObject({ command: 'serve', entry: 'docs/', snapdom: './dist', port: 8493 })
    expect(() => parseArgs(['serve'])).toThrow(/needs an HTML file/)
    expect(() => parseArgs(['serve', 'a.html', 'b.html'])).toThrow(/Unexpected argument/)
  })

  it('lets an operation host its own page with --serve, and rejects mixing it with --url', () => {
    const options = parseArgs(['capture', 'issue', '--serve', 'issue.html', '--snapdom', './dist', '--target', '#test'])
    expect(options).toMatchObject({ operation: 'capture', serve: 'issue.html', snapdom: './dist' })
    expect(() => parseArgs(['capture', 'issue', '--serve', 'issue.html', '--url', 'http://localhost:3000']))
      .toThrow(/either --url or --serve/)
    expect(() => parseArgs(['capture', 'issue', '--snapdom', './dist'])).toThrow(/--snapdom and --port/)
    expect(() => parseArgs(['capture', 'issue', '--port', '8080'])).toThrow(/--snapdom and --port/)
  })
})
