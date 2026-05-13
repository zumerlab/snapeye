/**
 * @zumer/snapeye — the bridge between a running web app and a coding agent.
 *
 *   Browser:  import { attachSnapEye }       from '@zumer/snapeye/client'
 *   Server:   import { createSnapEyeHandler } from '@zumer/snapeye/server'
 *
 * This entry re-exports both for convenience, but the sub-paths are the
 * canonical way to import — they keep bundlers from pulling Node-only
 * code into a browser build.
 */
export { attachSnapEye } from './client.js'
export { createSnapEyeHandler } from './server.js'
