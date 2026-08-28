import type { Plugin } from 'vite'

export interface SnapEyeViteClientOptions {
  /**
   * Mirror the page console to the Vite terminal. Patches `console` and sends
   * one request per line, so it is opt-in. Defaults to false.
   */
  forwardConsole?: boolean
  /** Show the in-page error overlay for uncaught errors. Defaults to false. */
  errorOverlay?: boolean
  /**
   * Single alphanumeric character that, with Shift, captures a baseline.
   * Defaults to false (no key is taken from the application). Keystrokes typed
   * into inputs, textareas, selects, or contenteditable elements never trigger
   * it.
   */
  hotkey?: string | false
  /** Baseline replaced by the hotkey capture. Defaults to "current". */
  hotkeyName?: string
}

export interface SnapEyeViteOptions {
  /** Artifact directory relative to Vite's project root. Defaults to .snapeye. */
  root?: string
  /** Number of newest run directories to retain. Defaults to 20. */
  maxRuns?: number
  /** In-page behavior of the automatically injected client. */
  client?: SnapEyeViteClientOptions
}

export declare function snapeye(options?: SnapEyeViteOptions): Plugin

export default snapeye
