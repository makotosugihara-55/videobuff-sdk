/**
 * Ambient type declaration for window.videobuff.
 * Lets page.evaluate / page.waitForFunction callbacks type-check
 * without importing the web app's module graph.
 */

interface VideoBuffAutomationAPI {
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

interface Window {
  videobuff?: VideoBuffAutomationAPI
}
