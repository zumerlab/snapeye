import { ERROR_CODES } from '../core/protocol.js'
import { SnapEyeError } from '../core/errors.js'

/**
 * Compatibility bridge for the 0.1 flat `/snap` + `/log` handler.
 * It intentionally supports capture only and is never used by the Vite plugin.
 */
export function createLegacyArtifactStore ({
  endpoint = '/__snapeye__',
  fetch: fetchImpl = globalThis.fetch
} = {}) {
  const base = String(endpoint).replace(/\/+$/, '')

  async function post (path, body, contentType) {
    let response
    try {
      response = await fetchImpl(`${base}/${path}`, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body
      })
    } catch {
      throw new SnapEyeError(ERROR_CODES.PERSIST_FAILED, 'The legacy SnapEye server is not reachable')
    }
    if (!response.ok) {
      throw new SnapEyeError(ERROR_CODES.PERSIST_FAILED, `The legacy SnapEye server returned ${response.status}`)
    }
  }

  return {
    legacy: true,
    readBaseline: async () => null,
    writeBaseline: async (name, baseline) => {
      await post(`snap?name=${encodeURIComponent(name)}`, baseline.image, 'image/png')
    },
    writeRunArtifact: async () => {},
    commitResult: async () => {},
    log: async (level, ...args) => {
      try {
        await post('log', `[${level}] ${args.map(String).join(' ')}`, 'text/plain')
        return true
      } catch {
        return false
      }
    }
  }
}

