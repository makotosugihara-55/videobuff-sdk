/**
 * Ambient type declaration for window.videobuff.
 *
 * Shared across core, mcp, and any other package that evaluates
 * code inside a browser context. Import this package's tsconfig
 * or reference this file to pick up the augmentation.
 */

/** Shared `{ ok: true }` return type for mutation methods. */
type OkResult = { readonly ok: true }

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
  selectClip: (input: { clipId: string | null }) => { selectedClipId: string | null }
  removeClip: (input: { clipId: string }) => OkResult
  splitClip: (input: { clipId: string; splitAtMs: number }) => OkResult
  moveClip: (input: { clipId: string; newStartMs: number }) => OkResult
  trimClipStart: (input: { clipId: string; newStartMs: number }) => OkResult
  trimClipEnd: (input: { clipId: string; newEndMs: number }) => OkResult
  // Flat shape: `clipId` + any subset of text-clip fields (text, fontSize, color, …).
  updateTextClip: (input: { clipId: string; [key: string]: unknown }) => OkResult
  undo: () => OkResult
  redo: () => OkResult
}

declare global {
  interface Window {
    videobuff?: VideoBuffAutomationAPI
  }
}
