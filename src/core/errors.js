import { ERROR_CODES } from './protocol.js'

const KNOWN_ERROR_CODES = new Set(Object.values(ERROR_CODES))

export class SnapEyeError extends Error {
  constructor (code, message, details) {
    super(message)
    this.name = 'SnapEyeError'
    this.code = KNOWN_ERROR_CODES.has(code) ? code : ERROR_CODES.CAPTURE_FAILED
    if (details && typeof details === 'object') this.details = details
  }
}

export function operationError (error, operation) {
  if (error instanceof SnapEyeError || KNOWN_ERROR_CODES.has(error?.code)) return error
  const fallback = operation === 'diff'
    ? ERROR_CODES.DIFF_FAILED
    : operation === 'record'
      ? ERROR_CODES.RECORD_FAILED
      : ERROR_CODES.CAPTURE_FAILED
  return new SnapEyeError(fallback, publicMessage(error, operation))
}

export function persistenceError (error) {
  if (error?.code === ERROR_CODES.PERSIST_FAILED) return error
  return new SnapEyeError(ERROR_CODES.PERSIST_FAILED, 'SnapEye could not persist the run artifacts')
}

function publicMessage (error, operation) {
  if (typeof error?.publicMessage === 'string') return error.publicMessage
  if (operation === 'diff') return 'SnapEye could not compare the current capture with its baseline'
  if (operation === 'record') return 'SnapEye could not record the target'
  return 'SnapEye could not capture the target'
}

