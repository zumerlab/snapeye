/**
 * SnapEye protocol constants — shared by the in-page runtime, the transport,
 * and the filesystem store. Isomorphic: no DOM, no Node APIs.
 *
 * `SCHEMA_VERSION` describes the shape of `result.json` / baseline metadata.
 * `PROTOCOL_VERSION` describes the HTTP + URL contract an agent talks to.
 * Bump them independently; both are published in every artifact.
 */

export const SCHEMA_VERSION = 1
export const PROTOCOL_VERSION = 1

/** Operations reachable from the URL trigger and from `window.snapeye`. */
export const OPERATIONS = ['capture', 'diff', 'record']

/** Stable, documented error codes. Agents may branch on these. */
export const ERROR_CODES = {
  INVALID_RUN_ID: 'INVALID_RUN_ID',
  INVALID_NAME: 'INVALID_NAME',
  INVALID_OPERATION: 'INVALID_OPERATION',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  BASELINE_NOT_FOUND: 'BASELINE_NOT_FOUND',
  BASELINE_INCOMPATIBLE: 'BASELINE_INCOMPATIBLE',
  CAPTURE_FAILED: 'CAPTURE_FAILED',
  DIFF_FAILED: 'DIFF_FAILED',
  RECORD_FAILED: 'RECORD_FAILED',
  PERSIST_FAILED: 'PERSIST_FAILED'
}

/** Default artifact filenames inside `.snapeye/runs/<runId>/`. */
export const ARTIFACTS = {
  result: 'result.json',
  current: 'current.png',
  diff: 'diff.png',
  frames: 'frames.png',
  gif: 'recording.gif',
  webm: 'recording.webm',
  mp4: 'recording.mp4'
}

/** Directory layout under the configured root. */
export const LAYOUT = {
  baselines: 'baselines',
  runs: 'runs'
}

/** Entries SnapEye guarantees inside `<root>/.gitignore`. Baselines stay tracked. */
export const GITIGNORE_ENTRIES = ['runs/', '*.tmp']

/** Server defaults. Mirrored by the Vite plugin options. */
export const DEFAULTS = {
  root: '.snapeye',
  maxRuns: 20,
  endpoint: '/__snapeye',
  /** Hard ceiling for a single artifact upload (bytes). */
  maxRequestBytes: 64 * 1024 * 1024
}

/** URL query key that triggers an operation on page load. */
export const TRIGGER_PARAM = '__snapeye'

/** Coordinate space used by every region and dimension SnapEye reports. */
export const COORDINATE_SPACE = 'target-css-px'

/** Documented, enforced ceilings for `record`. Keeps memory bounded. */
export const RECORD_LIMITS = {
  minDurationMs: 100,
  maxDurationMs: 15000,
  defaultDurationMs: 3000,
  minFps: 1,
  maxFps: 30,
  defaultFps: 10,
  maxFrames: 150,
  minScale: 0.1,
  maxScale: 2,
  defaultScale: 1,
  /** frameCount x width x height ceiling before scale is reduced. */
  maxTotalPixels: 120_000_000
}

/** Defaults for diff region extraction. All sizes are raster pixels. */
export const DIFF_DEFAULTS = {
  /** Mask is bucketed into tiles of this size before clustering. */
  tileSize: 8,
  /** Tiles within this many empty tiles of each other join the same region. */
  gapTiles: 2,
  /** Regions smaller than this (CSS px, both sides) are dropped as noise. */
  minRegionCssSide: 4,
  /** Regions with fewer changed CSS px^2 than this are dropped as noise. */
  minRegionCssArea: 24,
  /** More regions than this collapse into a single aggregate bounding box. */
  maxRegions: 12,
  /** snapDiff perceptual threshold (0..1). */
  threshold: 0.1
}

/** Defaults for the key-frame filmstrip. */
export const FILMSTRIP_DEFAULTS = {
  maxCells: 12,
  maxColumns: 4,
  /** Filmstrip PNG never exceeds this width in raster pixels. */
  maxWidth: 1600,
  gap: 8,
  background: '#ffffff'
}
