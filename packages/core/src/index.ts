/**
 * @videobuff/core
 *
 * Persistent Playwright session for driving VideoBuff programmatically.
 * One Chromium + one editor tab per process, reused across calls.
 */

export { VideoBuffSession, log } from './session.js'
export type { Session, SessionOptions } from './session.js'
