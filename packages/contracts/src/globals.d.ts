/**
 * Ambient type declaration for window.videobuff.
 *
 * Shared across core, mcp, and any other package that evaluates
 * code inside a browser context. Import this package's tsconfig
 * or reference this file to pick up the augmentation.
 */

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
}

declare global {
  interface Window {
    videobuff?: VideoBuffAutomationAPI
  }
}
