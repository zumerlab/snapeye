import type { IncomingMessage, ServerResponse } from 'node:http'

export interface SnapEyeLegacySnapEvent {
  name: string
  path: string
  bytes: number
}

export interface SnapEyeLegacyLogEvent {
  line: string
}

export interface CreateSnapEyeHandlerOptions {
  /** Output directory, resolved relative to process.cwd(). */
  dir?: string
  /** Legacy endpoint prefix. Defaults to /__snapeye__. */
  prefix?: string
  log?: ((line: string) => void) | null
  onSnap?: ((event: SnapEyeLegacySnapEvent) => void) | null
  onLog?: ((event: SnapEyeLegacyLogEvent) => void) | null
}

export type SnapEyeLegacyHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<boolean>

export declare function createSnapEyeHandler(
  options?: CreateSnapEyeHandlerOptions
): SnapEyeLegacyHandler

export default createSnapEyeHandler

