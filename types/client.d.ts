import type { SnapdomOptions } from '@zumer/snapdom'
import type {
  ArtifactStore,
  SnapEyeArtifactData,
  SnapEyeCaptureOptions,
  SnapEyeCaptureResult,
  SnapEyeDiffOptions,
  SnapEyeDiffResult,
  SnapEyeFilmstripMetadata,
  SnapEyeFilmstripOptions,
  SnapEyePixelDiffOptions,
  SnapEyeRecordOptions,
  SnapEyeRecordResult,
  SnapEyeResult,
  SnapEyeTarget,
  StoredBaseline
} from './shared.js'

export type {
  ArtifactStore,
  SnapEyeArtifactData,
  SnapEyeArtifactPaths,
  SnapEyeBaseOperationOptions,
  SnapEyeBaselineMetadata,
  SnapEyeBinaryData,
  SnapEyeCaptureOptions,
  SnapEyeCaptureResult,
  SnapEyeCaptureSuccessResult,
  SnapEyeDiffMetadata,
  SnapEyeDiffOptions,
  SnapEyeDiffRegion,
  SnapEyeDiffResult,
  SnapEyeDiffSuccessResult,
  SnapEyeErrorCode,
  SnapEyeErrorPayload,
  SnapEyeErrorResult,
  SnapEyeFilmstripCell,
  SnapEyeFilmstripMetadata,
  SnapEyeFilmstripOptions,
  SnapEyeHealth,
  SnapEyeImageMetadata,
  SnapEyeOperation,
  SnapEyePixelDiffOptions,
  SnapEyeRecordFormat,
  SnapEyeRecordMetadata,
  SnapEyeRecordOptions,
  SnapEyeRecordResult,
  SnapEyeRecordSuccessResult,
  SnapEyeRegionOptions,
  SnapEyeResult,
  SnapEyeResultBase,
  SnapEyeResultForOperation,
  SnapEyeResultOperation,
  SnapEyeStatus,
  SnapEyeSuccessResult,
  SnapEyeTarget,
  SnapEyeTargetMetadata,
  StoredBaseline
} from './shared.js'

export type SnapdomFunction = typeof import('@zumer/snapdom').snapdom

export interface SnapEyeDiffEngineResult {
  diff: number
  total: number
  ratio: number
  width: number
  height: number
  dimsMatch: boolean
  canvas: HTMLCanvasElement
}

export type SnapEyeDiffEngine = (
  baseline: HTMLCanvasElement,
  current: HTMLCanvasElement,
  options?: SnapEyePixelDiffOptions
) => SnapEyeDiffEngineResult

export interface SnapEyeVideoEncoding {
  blob: Blob
  filename: 'recording.webm' | 'recording.mp4'
  mimeType: string
}

export interface SnapEyeFilmstripOutput {
  canvas: HTMLCanvasElement
  meta: SnapEyeFilmstripMetadata
}

export interface SnapEyeAttachOptions {
  snapdom: SnapdomFunction
  store?: ArtifactStore
  /** Legacy spelling retained for custom adapters. */
  artifactStore?: ArtifactStore
  endpoint?: string
  token?: string | null
  /** Use the 0.1 flat capture handler. Capture/snap only; Vite never uses it. */
  legacy?: boolean
  autoOnQuery?: boolean
  triggerDelay?: number
  forwardConsole?: boolean
  errorOverlay?: boolean
  /**
   * Shift + this key runs `capture()` and replaces the `hotkeyName` baseline.
   * Never fires while typing into an editable element or with another
   * modifier held. Pass false/null to take no key from the application.
   */
  hotkey?: string | false | null
  /** Baseline the hotkey capture replaces. Defaults to "current". */
  hotkeyName?: string
  hideSelectors?: readonly string[]
  /**
   * Pin animations and transitions before capture/diff so an unchanged page
   * cannot report a change. Never applies to `record`. Defaults to true.
   */
  stabilize?: boolean
  /** Milliseconds, or a selector that must match, before capturing. */
  waitFor?: number | string | null
  /** Ceiling for a selector `waitFor`. Defaults to 5000. */
  waitTimeout?: number
  /**
   * Wait for the page to stop changing before capturing. A cold dev server
   * settles seconds after DOMContentLoaded. Defaults to true.
   */
  settle?: boolean
  /** Ceiling for the settle wait. Defaults to 2500. */
  settleTimeout?: number
  defaultTarget?: () => SnapEyeTarget | null | undefined
  snapdomOptions?: SnapdomOptions
  diffOptions?: SnapEyePixelDiffOptions
  filmstripOptions?: SnapEyeFilmstripOptions
  reuse?: boolean
  fetch?: typeof globalThis.fetch
  window?: Window
  document?: Document

  /** Advanced dependency hook, primarily useful for deterministic tests. */
  now?: () => number
  /** Advanced dependency hook, primarily useful for deterministic tests. */
  dateNow?: () => number
  /** Advanced dependency hook, primarily useful for deterministic tests. */
  wait?: (milliseconds: number) => void | PromiseLike<void>
  /** Advanced dependency hook, primarily useful for deterministic tests. */
  random?: () => number
  /** Advanced dependency hook, primarily useful for deterministic tests. */
  diffCanvas?: SnapEyeDiffEngine
  /** Advanced dependency hook, primarily useful for deterministic tests. */
  encodeGif?: (
    frames: HTMLCanvasElement[],
    timestampsMs: number[],
    options: { fps: number; durationMs: number }
  ) => Promise<Blob | Uint8Array | ArrayBuffer>
  /** Advanced dependency hook, primarily useful for deterministic tests. */
  encodeVideo?: (
    frames: HTMLCanvasElement[],
    timestampsMs: number[],
    options: { fps: number; durationMs: number; bitrate?: number; document: Document }
  ) => Promise<SnapEyeVideoEncoding>
  /** Advanced dependency hook, primarily useful for deterministic tests. */
  createFilmstrip?: (
    frames: HTMLCanvasElement[],
    timestampsMs: number[],
    options: SnapEyeFilmstripOptions & { document: Document }
  ) => SnapEyeFilmstripOutput
  /** Advanced dependency hook, primarily useful for deterministic tests. */
  freezeMotion?: (
    document: Document,
    deps: { window?: Window; wait?: (milliseconds: number) => Promise<void> }
  ) => Promise<() => void>
  /** Advanced dependency hook, primarily useful for deterministic tests. */
  waitForReady?: (
    spec: number | string | null | undefined,
    deps: {
      document: Document
      wait: (milliseconds: number) => Promise<void>
      now: () => number
      timeoutMs?: number
    }
  ) => Promise<void>
}

export interface SnapEyePublicOptions {
  endpoint: string
  autoOnQuery: boolean
  forwardConsole: boolean
  errorOverlay: boolean
  hotkey: string | false | null
  hotkeyName: string
  hideSelectors: string[]
  stabilize: boolean
  settle: boolean
  waitFor: number | string | null
  snapdomOptions: SnapdomOptions
}

export interface SnapEyeCaptureMethod {
  (name: string, options?: SnapEyeCaptureOptions): Promise<SnapEyeCaptureResult>
  (
    name: string,
    target: SnapEyeTarget | null | undefined,
    options?: SnapEyeCaptureOptions
  ): Promise<SnapEyeCaptureResult>
}

export interface SnapEyeDiffMethod {
  (name: string, options?: SnapEyeDiffOptions): Promise<SnapEyeDiffResult>
  (
    name: string,
    target: SnapEyeTarget | null | undefined,
    options?: SnapEyeDiffOptions
  ): Promise<SnapEyeDiffResult>
}

export interface SnapEyeRecordMethod {
  (name: string, options?: SnapEyeRecordOptions): Promise<SnapEyeRecordResult>
  (
    name: string,
    target: SnapEyeTarget | null | undefined,
    options?: SnapEyeRecordOptions
  ): Promise<SnapEyeRecordResult>
}

export interface SnapEyeApi {
  capture: SnapEyeCaptureMethod
  diff: SnapEyeDiffMethod
  record: SnapEyeRecordMethod
  /** Legacy alias of capture(). */
  snap: SnapEyeCaptureMethod
  log(level: string, ...args: unknown[]): Promise<boolean>
  runUrlTrigger(href?: string): Promise<SnapEyeResult | null>
  destroy(): void
  options: SnapEyePublicOptions
  protocolVersion: 1
}

export interface HttpArtifactStore extends ArtifactStore {
  log(level: string, ...args: unknown[]): Promise<boolean>
}

export interface HttpArtifactStoreOptions {
  endpoint?: string
  token?: string | null
  fetch?: typeof globalThis.fetch
}

export declare function createHttpArtifactStore(
  options?: HttpArtifactStoreOptions
): HttpArtifactStore

export interface LegacyArtifactStoreOptions {
  endpoint?: string
  fetch?: typeof globalThis.fetch
}

export interface LegacyArtifactStore extends ArtifactStore {
  readonly legacy: true
  log(level: string, ...args: unknown[]): Promise<boolean>
}

export declare function createLegacyArtifactStore(
  options?: LegacyArtifactStoreOptions
): LegacyArtifactStore

export declare function attachSnapEye(options: SnapEyeAttachOptions): SnapEyeApi

export default attachSnapEye

declare global {
  interface Window {
    snapeye: SnapEyeApi
  }
}
