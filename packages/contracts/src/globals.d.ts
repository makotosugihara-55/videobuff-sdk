/**
 * Ambient type declaration for window.videobuff.
 *
 * Shared across core, mcp, and any other package that evaluates
 * code inside a browser context. Import this package's tsconfig
 * or reference this file to pick up the augmentation.
 */

/**
 * Shared result type for mutation methods.
 *
 * Discriminated on `ok` — see `schemas.ts#okResultSchema` for the
 * authoritative shape and rationale. In short: `{ok:true}` means the
 * mutation landed, `{ok:false, reason}` means it was rejected (e.g.
 * the clipId no longer exists).
 */
type OkResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/** `selectClip` result — see `schemas.ts#selectClipResultSchema`. */
type SelectClipResult =
  | { readonly ok: true; readonly selectedClipId: string | null }
  | { readonly ok: false; readonly reason: string }

/** `addAssetToTimeline` result — see `schemas.ts#addAssetToTimelineResultSchema`. */
type AddAssetToTimelineResult =
  | { readonly ok: true; readonly clipId: string | null }
  | { readonly ok: false; readonly reason: string }

/** Aspect ratio options supported by the project. */
type AspectRatio = '16:9' | '9:16' | '1:1' | '4:3'

/** All transitions that can be applied to a clip edge. */
type TransitionType =
  | 'none' | 'dissolve' | 'fade-black' | 'fade-white'
  | 'blur' | 'zoom' | 'wipe' | 'typewriter'

/** Compositing blend modes for image clips. */
type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay'
  | 'darken' | 'lighten' | 'color-dodge' | 'color-burn'
  | 'hard-light' | 'soft-light' | 'difference' | 'exclusion'

/** Per-edge transition target (Phase 2). */
type TransitionEdge = 'in' | 'out'

/** Sibling-track move direction (Phase 2). */
type SiblingDirection = 'up' | 'down'

export interface VideoBuffAutomationAPI {
  readonly ready: true
  readonly version: string
  ping: () => { pong: true; time: number }
  getProjectInfo: () => unknown
  getUIState: () => unknown
  addTextClip: (input: { startMs: number }) => { clipId: string | null }
  setPlayheadMs: (input: { ms: number }) => { playheadMs: number }
  togglePlay: () => { isPlaying: boolean }
  exportToBlob: (input?: Record<string, unknown>) => Promise<{
    base64: string
    byteLength: number
    mimeType: string
    durationMs: number
    settings: Record<string, unknown>
  }>
  selectClip: (input: { clipId: string | null }) => SelectClipResult
  removeClip: (input: { clipId: string }) => OkResult
  splitClip: (input: { clipId: string; splitAtMs: number }) => OkResult
  moveClip: (input: { clipId: string; newStartMs: number }) => OkResult
  trimClipStart: (input: { clipId: string; newStartMs: number }) => OkResult
  trimClipEnd: (input: { clipId: string; newEndMs: number }) => OkResult
  // Flat shape: `clipId` + any subset of text-clip fields (text, fontSize, color, …).
  updateTextClip: (input: { clipId: string; [key: string]: unknown }) => OkResult
  undo: () => OkResult
  redo: () => OkResult

  // ── Phase 1 — project settings & clip properties ──────────────
  setProjectName: (input: { name: string }) => OkResult
  setAspectRatio: (input: { aspectRatio: AspectRatio }) => OkResult
  // Flat shape: `clipId` + any subset of Transform fields.
  updateClipTransform: (input: { clipId: string; [key: string]: unknown }) => OkResult
  // Flat shape: `clipId` + any subset of ColorGrade fields.
  updateClipColorGrade: (input: { clipId: string; [key: string]: unknown }) => OkResult
  updateClipTransition: (input: {
    clipId: string
    type?: TransitionType
    durationMs?: number
  }) => OkResult
  updateClipVolume: (input: { clipId: string; volume: number }) => OkResult
  // Flat shape: `clipId` + any subset of SpeedConfig fields.
  updateClipSpeed: (input: { clipId: string; [key: string]: unknown }) => OkResult
  updateImageClip: (input: {
    clipId: string
    opacity?: number
    blendMode?: BlendMode
    borderRadius?: number
  }) => OkResult
  // Per-field shadow patch — see `updateImageClipShadowInputSchema`.
  updateImageClipShadow: (input: {
    clipId: string
    enabled?: boolean
    color?: string
    blur?: number
    offsetX?: number
    offsetY?: number
  }) => OkResult
  unlinkClip: (input: { clipId: string }) => OkResult
  relinkClip: (input: { clipId: string }) => OkResult

  // ── Phase 2 — per-edge transition / track move / audio effect ─
  updateClipTransitionEdge: (input: {
    clipId: string
    edge: TransitionEdge
    type?: TransitionType
    durationMs?: number
  }) => OkResult
  clearClipTransitionOverride: (input: { clipId: string; edge: TransitionEdge }) => OkResult
  moveClipToSiblingTrack: (input: { clipId: string; direction: SiblingDirection }) => OkResult
  // Flat shape: `clipId` + any subset of AudioEffect fields.
  updateClipAudioEffect: (input: { clipId: string; [key: string]: unknown }) => OkResult

  // ── Asset management ────────────────────────────────────────
  // Fails with `assetNotFound` for a missing id, `assetInUse` when any
  // clip still references the asset. See bootstrap.ts for rationale.
  removeAsset: (input: { assetId: string }) => OkResult
  // Place an already-imported asset on the timeline. Returns the new
  // clipId (the video half for video assets) or `assetNotFound`.
  addAssetToTimeline: (input: { assetId: string }) => AddAssetToTimelineResult

  // ── Project lifecycle ───────────────────────────────────────
  // Replace the current project with a fresh empty one. Revokes asset
  // blob URLs and clears the undo history. Always succeeds.
  resetProject: () => OkResult
}

declare global {
  interface Window {
    videobuff?: VideoBuffAutomationAPI
  }
}
