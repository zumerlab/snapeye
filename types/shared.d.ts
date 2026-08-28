import type { SnapdomOptions } from '@zumer/snapdom'

export type SnapEyeOperation = 'capture' | 'diff' | 'record'
export type SnapEyeResultOperation = SnapEyeOperation | 'unknown'
export type SnapEyeStatus = 'ok' | 'error'
export type SnapEyeRecordFormat = 'gif' | 'video' | 'both'

export type SnapEyeErrorCode =
  | 'INVALID_RUN_ID'
  | 'INVALID_NAME'
  | 'INVALID_OPERATION'
  | 'TARGET_NOT_FOUND'
  | 'BASELINE_NOT_FOUND'
  | 'BASELINE_INCOMPATIBLE'
  | 'CAPTURE_FAILED'
  | 'DIFF_FAILED'
  | 'RECORD_FAILED'
  | 'PERSIST_FAILED'

export type SnapEyeTarget = string | Element

export type SnapEyeTargetMetadata =
  | { selector: string; descriptor?: never }
  | { selector?: never; descriptor: string }

export interface SnapEyeImageMetadata {
  /** Axis-aligned SnapDOM capture viewport associated with the target. */
  coordinateSpace: 'target-css-px'
  /** Capture viewport width in CSS pixels. */
  cssWidth: number
  /** Capture viewport height in CSS pixels. */
  cssHeight: number
  pixelWidth: number
  pixelHeight: number
  /** Raster pixels per CSS pixel. */
  scale: number
}

export interface SnapEyeDiffRegion {
  /** CSS pixels from the capture viewport's left edge. */
  x: number
  /** CSS pixels from the capture viewport's top edge. */
  y: number
  /** Width in capture-viewport CSS pixels. */
  width: number
  /** Height in capture-viewport CSS pixels. */
  height: number
  aggregate: boolean
}

export interface SnapEyeDiffMetadata {
  changed: boolean
  /** Fraction of compared raster pixels that changed, in the inclusive range 0..1. */
  changedRatio: number
  regionCount: number
  regionsTruncated: boolean
  regions: SnapEyeDiffRegion[]
}

export interface SnapEyeFilmstripCell {
  cell: number
  frameIndex: number
  timestampMs: number
  x: number
  y: number
}

export interface SnapEyeFilmstripMetadata {
  file: 'frames.png'
  columns: number
  rows: number
  cellWidth: number
  cellHeight: number
  gap: number
  width: number
  height: number
  cells: SnapEyeFilmstripCell[]
}

export interface SnapEyeRecordMetadata {
  durationRequestedMs: number
  durationActualMs: number
  fpsRequested: number
  fpsActual: number
  frameCount: number
  timestampsMs: number[]
  format: SnapEyeRecordFormat
  filmstrip: SnapEyeFilmstripMetadata
}

export interface SnapEyeErrorPayload {
  code: SnapEyeErrorCode
  message: string
  details?: Record<string, unknown>
}

export interface SnapEyeArtifactPaths {
  baseline?: string
  current?: 'current.png'
  diff?: 'diff.png'
  frames?: 'frames.png'
  gif?: 'recording.gif'
  video?: 'recording.webm' | 'recording.mp4'
}

export interface SnapEyeResultBase {
  schemaVersion: 1
  protocolVersion: 1
  runId: string
  status: SnapEyeStatus
  operation: SnapEyeResultOperation
  name?: string
  target?: SnapEyeTargetMetadata
  startedAt?: string
  finishedAt?: string
}

export interface SnapEyeCaptureSuccessResult extends SnapEyeResultBase {
  status: 'ok'
  operation: 'capture'
  name: string
  target: SnapEyeTargetMetadata
  image: SnapEyeImageMetadata
  artifacts: SnapEyeArtifactPaths & { baseline: string }
  diff?: never
  record?: never
  error?: never
}

export interface SnapEyeDiffSuccessResult extends SnapEyeResultBase {
  status: 'ok'
  operation: 'diff'
  name: string
  target: SnapEyeTargetMetadata
  image: SnapEyeImageMetadata
  diff: SnapEyeDiffMetadata
  artifacts: SnapEyeArtifactPaths & {
    baseline: string
    current: 'current.png'
    diff: 'diff.png'
  }
  record?: never
  error?: never
}

export interface SnapEyeRecordSuccessResult extends SnapEyeResultBase {
  status: 'ok'
  operation: 'record'
  name: string
  target: SnapEyeTargetMetadata
  image: SnapEyeImageMetadata
  record: SnapEyeRecordMetadata
  artifacts: SnapEyeArtifactPaths & { frames: 'frames.png' }
  diff?: never
  error?: never
}

export interface SnapEyeErrorResult<
  Operation extends SnapEyeResultOperation = SnapEyeResultOperation
> extends SnapEyeResultBase {
  status: 'error'
  operation: Operation
  error: SnapEyeErrorPayload
  artifacts?: SnapEyeArtifactPaths
  image?: never
  diff?: never
  record?: never
}

export type SnapEyeSuccessResult =
  | SnapEyeCaptureSuccessResult
  | SnapEyeDiffSuccessResult
  | SnapEyeRecordSuccessResult

export type SnapEyeResult = SnapEyeSuccessResult | SnapEyeErrorResult

export type SnapEyeCaptureResult =
  | SnapEyeCaptureSuccessResult
  | SnapEyeErrorResult<'capture'>

export type SnapEyeDiffResult =
  | SnapEyeDiffSuccessResult
  | SnapEyeErrorResult<'diff'>

export type SnapEyeRecordResult =
  | SnapEyeRecordSuccessResult
  | SnapEyeErrorResult<'record'>

export type SnapEyeResultForOperation<Operation extends SnapEyeOperation> =
  Operation extends 'capture'
    ? SnapEyeCaptureResult
    : Operation extends 'diff'
      ? SnapEyeDiffResult
      : SnapEyeRecordResult

/** Payload of `GET /__snapeye/health`. */
export interface SnapEyeHealth {
  status: 'ok'
  name: string
  version: string
  protocolVersion: number
  /** Artifact root as configured, relative to the dev server's project root. */
  artifactRoot: string
  /** Absolute artifact root, resolved by the server. Added after protocol 1. */
  artifactRootResolved: string | null
}

export interface SnapEyeBaselineMetadata {
  schemaVersion: 1
  name: string
  capturedAt: string
  target: SnapEyeTargetMetadata
  image: SnapEyeImageMetadata
}

export type SnapEyeBinaryData = Blob | Uint8Array | ArrayBuffer
export type SnapEyeArtifactData = SnapEyeBinaryData | string

export interface StoredBaseline {
  /** Present on values returned by the built-in stores; optional for writes. */
  name?: string
  image: SnapEyeBinaryData
  /** Null supports reading a legacy PNG that has no trustworthy metadata. */
  meta: SnapEyeBaselineMetadata | null
}

export interface ArtifactStore {
  readBaseline(name: string): Promise<StoredBaseline | null>
  writeBaseline(name: string, baseline: StoredBaseline): Promise<void>
  writeRunArtifact(
    runId: string,
    filename: string,
    data: SnapEyeArtifactData
  ): Promise<void>
  /** Atomically publishes result.json after every other run artifact. */
  commitResult(runId: string, result: SnapEyeResult): Promise<void>
}

export interface SnapEyeBaseOperationOptions {
  /** Pin animations before this operation. Ignored by `record`. */
  stabilize?: boolean
  /** Milliseconds, or a selector that must match, before capturing. */
  waitFor?: number | string
  /** Ceiling for a selector `waitFor`. */
  waitTimeout?: number
  /** Wait for the page to stop changing before capturing. Defaults to true. */
  settle?: boolean
  /** Ceiling for the settle wait. */
  settleTimeout?: number
  runId?: string
  /** Alternative to the positional target argument. */
  target?: SnapEyeTarget | null
  scale?: number
  snapdomOptions?: SnapdomOptions
}

export interface SnapEyeCaptureOptions extends SnapEyeBaseOperationOptions {}

export interface SnapEyePixelDiffOptions {
  threshold?: number
  includeAA?: boolean
  alpha?: number
  aaColor?: [number, number, number]
  diffColor?: [number, number, number]
  diffMask?: boolean
}

export interface SnapEyeRegionOptions {
  tileSize?: number
  gapTiles?: number
  minRegionCssSide?: number
  minRegionCssArea?: number
  maxRegions?: number
}

export interface SnapEyeDiffOptions extends SnapEyeBaseOperationOptions {
  diffOptions?: SnapEyePixelDiffOptions
  regionOptions?: SnapEyeRegionOptions
}

export interface SnapEyeFilmstripOptions {
  maxCells?: number
  maxColumns?: number
  maxWidth?: number
  gap?: number
  background?: string
}

export interface SnapEyeRecordOptions extends SnapEyeBaseOperationOptions {
  duration?: number
  fps?: number
  format?: SnapEyeRecordFormat
  bitrate?: number
  filmstripOptions?: SnapEyeFilmstripOptions
}
