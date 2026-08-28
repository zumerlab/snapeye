import { describe, expect, it } from 'vitest'
import {
  MAX_ID_LENGTH,
  assertName,
  assertRunId,
  generateRunId,
  isValidFilename,
  isValidName,
  isValidRunId,
  sanitizeName
} from '../../src/core/ids.js'

describe('identifier validation', () => {
  it('accepts the documented run-id alphabet and length boundary', () => {
    expect(isValidRunId('abc-123_RUN')).toBe(true)
    expect(isValidRunId('A'.repeat(MAX_ID_LENGTH))).toBe(true)
  })

  it.each([
    '',
    'A'.repeat(MAX_ID_LENGTH + 1),
    '../escape',
    'nested/run',
    'nested\\run',
    'run..old',
    'white space',
    'control\u0000char',
    '.hidden'
  ])('rejects unsafe run id %j', value => {
    expect(isValidRunId(value)).toBe(false)
  })

  it('validates baseline names and artifact filenames independently', () => {
    expect(isValidName('dashboard.v1')).toBe(true)
    expect(isValidName('.dashboard')).toBe(false)
    expect(isValidName('dashboard..old')).toBe(false)
    expect(isValidFilename('current.png')).toBe(true)
    expect(isValidFilename('result.json')).toBe(true)
    expect(isValidFilename('partial.tmp')).toBe(false)
    expect(isValidFilename('trailing.')).toBe(false)
    expect(isValidFilename('../current.png')).toBe(false)
  })

  it('sanitizes fallback-safe names but never run ids', () => {
    expect(sanitizeName(' hero / main ')).toBe('hero___main_')
    expect(sanitizeName('...', 'fallback')).toBe('fallback')
    expect(() => assertRunId('../run')).toThrow(/Invalid SnapEye run id/)
    expect(() => assertName('.hidden')).toThrow(/Invalid SnapEye name/)

    try {
      assertRunId('../run')
    } catch (error) {
      expect(error.code).toBe('INVALID_RUN_ID')
    }
  })
})

describe('run-id generation', () => {
  it('generates a valid deterministic id from injected time and randomness', () => {
    const id = generateRunId(0, () => 0)

    expect(id).toBe('r000000000000000')
    expect(isValidRunId(id)).toBe(true)
  })

  it('changes with time or entropy', () => {
    const first = generateRunId(1, () => 0)
    const later = generateRunId(2, () => 0)
    const random = generateRunId(1, () => 0.5)

    expect(new Set([first, later, random]).size).toBe(3)
  })
})
