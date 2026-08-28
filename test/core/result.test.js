import { describe, expect, it } from 'vitest'
import { ERROR_CODES, PROTOCOL_VERSION, SCHEMA_VERSION } from '../../src/core/protocol.js'
import { buildErrorResult, buildResult, validateResult } from '../../src/core/result.js'

describe('terminal result construction', () => {
  it('builds a compact successful result and omits irrelevant sections', () => {
    const result = buildResult({
      runId: 'captureRun',
      status: 'ok',
      operation: 'capture',
      name: 'dashboard',
      target: { selector: '#dashboard' },
      image: { coordinateSpace: 'target-css-px', scale: 2 },
      artifacts: { baseline: '../../baselines/dashboard.png' }
    })

    expect(result).toEqual({
      schemaVersion: SCHEMA_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      runId: 'captureRun',
      status: 'ok',
      operation: 'capture',
      name: 'dashboard',
      target: { selector: '#dashboard' },
      image: { coordinateSpace: 'target-css-px', scale: 2 },
      artifacts: { baseline: '../../baselines/dashboard.png' }
    })
    expect(result).not.toHaveProperty('error')
    expect(result).not.toHaveProperty('diff')
    expect(validateResult(result, 'captureRun')).toBeNull()
  })

  it('builds a stable error result without exposing a stack', () => {
    const result = buildErrorResult({
      runId: 'errorRun',
      operation: 'diff',
      name: 'dashboard',
      code: ERROR_CODES.BASELINE_NOT_FOUND,
      message: 'No baseline exists for dashboard',
      details: { expected: 'dashboard' }
    })

    expect(result.status).toBe('error')
    expect(result.error).toEqual({
      code: ERROR_CODES.BASELINE_NOT_FOUND,
      message: 'No baseline exists for dashboard',
      details: { expected: 'dashboard' }
    })
    expect(JSON.stringify(result)).not.toContain('stack')
    expect(validateResult(result, 'errorRun')).toBeNull()
  })

  it('normalizes unknown error codes to a stable public code', () => {
    const result = buildErrorResult({
      runId: 'errorRun',
      operation: 'capture',
      code: 'PRIVATE_INTERNAL_FAILURE',
      message: 'Capture failed'
    })

    expect(result.error.code).toBe(ERROR_CODES.CAPTURE_FAILED)
  })
})

describe('terminal result validation', () => {
  const valid = buildResult({
    runId: 'validRun',
    status: 'ok',
    operation: 'record',
    name: 'menu'
  })

  it.each([
    [null, /object/],
    [{ ...valid, schemaVersion: 999 }, /schemaVersion/],
    [{ ...valid, protocolVersion: 999 }, /protocolVersion/],
    [{ ...valid, runId: '../run' }, /run id/],
    [{ ...valid, status: 'pending' }, /status/],
    [{ ...valid, operation: 'navigate' }, /operation/]
  ])('rejects malformed terminal payloads', (value, message) => {
    expect(validateResult(value, 'validRun')).toMatch(message)
  })

  it('rejects a result from a different run namespace', () => {
    expect(validateResult(valid, 'anotherRun')).toMatch(/does not match/)
  })

  it('requires a known error object when status is error', () => {
    expect(validateResult({ ...valid, status: 'error' }, 'validRun')).toMatch(/error object/)
    expect(validateResult({
      ...valid,
      status: 'error',
      error: { code: 'UNKNOWN', message: 'bad' }
    }, 'validRun')).toMatch(/unknown error code/)
  })
})
