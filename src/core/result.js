/**
 * `result.json` builders and validation.
 *
 * Every run that reaches the client ends with exactly one terminal result,
 * `status: "ok"` or `status: "error"`, written atomically as the last step.
 * An agent reads `status` first and only then interprets the rest.
 *
 * Sections that do not apply to an operation are omitted rather than filled
 * with nulls, so `"diff" in result` is a meaningful check.
 */
import { SCHEMA_VERSION, PROTOCOL_VERSION, OPERATIONS, ERROR_CODES } from './protocol.js'
import { isValidRunId } from './ids.js'

const KNOWN_CODES = new Set(Object.values(ERROR_CODES))
const KNOWN_OPERATIONS = new Set([...OPERATIONS, 'unknown'])

/**
 * Build a terminal result.
 *
 * @param {object} input
 * @param {string} input.runId
 * @param {'ok'|'error'} input.status
 * @param {string} input.operation
 * @param {string} [input.name]
 * @param {object} [input.target] `{ selector?, descriptor? }`
 * @param {object} [input.image] `{ coordinateSpace, cssWidth, ... }`
 * @param {object} [input.diff]
 * @param {object} [input.record]
 * @param {object} [input.artifacts] relative paths, from the run directory
 * @param {object} [input.error] `{ code, message, details? }`
 * @returns {object} result.json payload
 */
export function buildResult (input) {
  const result = {
    schemaVersion: SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    runId: input.runId,
    status: input.status,
    operation: input.operation
  }

  if (input.name != null) result.name = input.name
  if (input.startedAt) result.startedAt = input.startedAt
  if (input.finishedAt) result.finishedAt = input.finishedAt
  if (input.target && Object.keys(input.target).length) result.target = input.target
  if (input.image) result.image = input.image
  if (input.diff) result.diff = input.diff
  if (input.record) result.record = input.record
  if (input.artifacts && Object.keys(input.artifacts).length) result.artifacts = input.artifacts
  if (input.status === 'error') result.error = normalizeError(input.error)

  return result
}

/** Convenience wrapper for the error path. Never leaks a stack trace. */
export function buildErrorResult ({ runId, operation, name, code, message, details, artifacts, target, startedAt, finishedAt }) {
  return buildResult({
    runId,
    status: 'error',
    operation: operation || 'unknown',
    name,
    target,
    artifacts,
    startedAt,
    finishedAt,
    error: { code, message, details }
  })
}

function normalizeError (error) {
  const code = error && KNOWN_CODES.has(error.code) ? error.code : ERROR_CODES.CAPTURE_FAILED
  const out = {
    code,
    message: String((error && error.message) || 'SnapEye run failed')
  }
  // `details` is a plain, hand-picked object (dimensions, limits). Stack
  // traces and raw exception text stay in the dev console.
  if (error && error.details && typeof error.details === 'object') out.details = error.details
  return out
}

/**
 * Reject anything that is not a terminal SnapEye result before it is written
 * to disk — the middleware trusts nothing the page sends.
 *
 * @returns {string|null} an error message, or null when the payload is valid
 */
export function validateResult (result, expectedRunId) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 'result must be an object'
  if (result.schemaVersion !== SCHEMA_VERSION) return `unsupported schemaVersion: ${result.schemaVersion}`
  if (result.protocolVersion !== PROTOCOL_VERSION) return `unsupported protocolVersion: ${result.protocolVersion}`
  if (!isValidRunId(result.runId)) return 'result.runId is not a valid run id'
  if (expectedRunId != null && result.runId !== expectedRunId) return 'result.runId does not match the run being committed'
  if (result.status !== 'ok' && result.status !== 'error') return 'result.status must be "ok" or "error"'
  if (!KNOWN_OPERATIONS.has(result.operation)) return `unknown operation: ${result.operation}`
  if (result.status === 'error') {
    if (!result.error || typeof result.error !== 'object') return 'error result must carry an error object'
    if (!KNOWN_CODES.has(result.error.code)) return `unknown error code: ${result.error.code}`
  }
  return null
}
