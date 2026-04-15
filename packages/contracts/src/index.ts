/**
 * @videobuff/contracts
 *
 * Single source of truth for the VideoBuff automation API.
 * All types, schemas, and operation definitions live here.
 * Both the web-side ACL (src/automation/) and the SDK-side
 * (core, mcp, cli) import from this package — never duplicate.
 */

export * from './types.js'
export * from './schemas.js'
export * from './operations.js'
export * from './env.js'
export type { VideoBuffAutomationAPI } from './globals.js'
