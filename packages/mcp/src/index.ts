#!/usr/bin/env node
/**
 * @videobuff/mcp — MCP server that drives VideoBuff via Playwright.
 *
 * Transport: stdio (single-user, local)
 * Lifecycle: one persistent session reused across calls (via @videobuff/core)
 * Contract:  schemas and operations from @videobuff/contracts
 *
 * Token-budget notes:
 *  - Tool `title` fields omitted: clients display either title OR description
 *  - Descriptions kept to one short clause
 *  - textResult uses non-indented JSON (~25% fewer tokens)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Page } from 'playwright'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  operations,
  type OperationName,
  exportToBlobInputSchema,
  addTextClipInputSchema,
  setPlayheadInputSchema,
  selectClipInputSchema,
  removeClipInputSchema,
  splitClipInputSchema,
  moveClipInputSchema,
  trimClipStartInputSchema,
  trimClipEndInputSchema,
  updateTextClipInputSchema,
  setProjectNameInputSchema,
  setAspectRatioInputSchema,
  updateClipTransformInputSchema,
  updateClipColorGradeInputSchema,
  updateClipTransitionInputSchema,
  updateClipVolumeInputSchema,
  updateClipSpeedInputSchema,
  updateImageClipInputSchema,
  updateImageClipShadowInputSchema,
  unlinkClipInputSchema,
  relinkClipInputSchema,
  updateClipTransitionEdgeInputSchema,
  clearClipTransitionOverrideInputSchema,
  moveClipToSiblingTrackInputSchema,
  updateClipAudioEffectInputSchema,
  importAssetsInputSchema,
  type VideoBuffAutomationAPI,
} from '@videobuff/contracts'
import { VideoBuffSession, log } from '@videobuff/core'

/**
 * Structural shape for a Zod object's `.shape`. Kept local so this package
 * doesn't need a direct zod dependency (all Zod types flow transitively
 * through @videobuff/contracts).
 */
// biome-ignore lint/suspicious/noExplicitAny: zod internal shape type is not worth reimporting
type SchemaShape = Record<string, any>
type ToolArgs = Record<string, unknown>

// ── Constants ────────────────────────────────────────────────

const SERVER_NAME = 'videobuff'
const SERVER_VERSION = '0.1.0'
const EXPORT_FILENAME_PREFIX = 'videobuff-export-'
const EXPORT_FILENAME_SUFFIX = '.mp4'
const DEFAULT_VIDEO_MIME = 'video/mp4'

/**
 * Asset import pipeline — MediaBrowser's hidden file input.
 *
 * The selector targets the `data-automation` attribute the web app
 * adds purely for automation. Polling happens because MediaBrowser's
 * `handleFiles` is async (Demuxer parse + thumbnail gen + OPFS write);
 * a 30-second ceiling is generous for a 1-GB video on average hardware.
 */
const MEDIA_IMPORT_INPUT_SELECTOR = 'input[data-automation="media-import"]'
const IMPORT_POLL_TIMEOUT_MS = 30_000
const IMPORT_POLL_INTERVAL_MS = 200

// ── Tool result helpers ──────────────────────────────────────

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
  [x: string]: unknown
}

function textResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] }
}

function errorResult(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err)
  return { isError: true, content: [{ type: 'text', text: `Error: ${msg}` }] }
}

// ── Session + page helper ────────────────────────────────────

const session = new VideoBuffSession()

async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<ToolResult> {
  try {
    const { page } = await session.get()
    return textResult(await fn(page))
  } catch (e) {
    return errorResult(e)
  }
}

// ── Generic tool registration helpers ────────────────────────
//
// The 20+ non-export tools all share the same skeleton:
//   registerTool(name, { description, inputSchema }, (args) =>
//     withPage(page => page.evaluate(
//       (a) => window.videobuff![method](a),
//       args,
//     ))
//   )
// Only `description`, `inputSchema`, and the target method name vary.
// These helpers collapse ~180 lines of repetition into declarative calls.
//
// The `as unknown as …` casts at the page.evaluate boundary are
// unavoidable — Playwright serializes the fn body and its args, so the
// static API type can't follow through. Zod validates inputs *before*
// this layer, so runtime safety is intact. We alias the dynamic-call
// record type to keep the evaluate bodies readable.

/** Methods on VideoBuffAutomationAPI that take no arguments. */
type NoArgMethod = {
  [K in keyof VideoBuffAutomationAPI]:
    VideoBuffAutomationAPI[K] extends () => unknown ? K : never
}[keyof VideoBuffAutomationAPI]

/**
 * Method names eligible for `registerArgTool`: everything on the API
 * except the zero-arg methods and the constants / special tools that
 * have bespoke registration (`exportToBlob`).
 */
type ArgMethod = Exclude<
  keyof VideoBuffAutomationAPI,
  NoArgMethod | 'ready' | 'version' | 'exportToBlob'
>

/** Register a tool whose underlying API method takes zero arguments. */
function registerNoArgTool(toolName: string, opName: OperationName, method: NoArgMethod): void {
  server.registerTool(
    toolName,
    { description: operations[opName].description, inputSchema: {} },
    () =>
      withPage((page) =>
        page.evaluate(
          (m: string) => {
            type Invoker = Record<string, () => unknown>
            return (window.videobuff as unknown as Invoker)[m]!()
          },
          method,
        ),
      ),
  )
}

/** Register a tool whose underlying API method takes a single object argument. */
function registerArgTool(
  toolName: string,
  opName: OperationName,
  schema: { shape: SchemaShape },
  method: ArgMethod,
): void {
  server.registerTool(
    toolName,
    { description: operations[opName].description, inputSchema: schema.shape },
    (args: ToolArgs) =>
      withPage((page) =>
        page.evaluate(
          ({ m, a }: { m: string; a: ToolArgs }) => {
            type Invoker = Record<string, (x: unknown) => unknown>
            return (window.videobuff as unknown as Invoker)[m]!(a)
          },
          { m: method, a: args },
        ),
      ),
  )
}

// ── MCP server ────────────────────────────────────────────────

const server = new McpServer(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
)

// ── Simple tools (no args) ────────────────────────────────────

registerNoArgTool('videobuff_ping',          'ping',           'ping')
registerNoArgTool('videobuff_get_project',   'getProjectInfo', 'getProjectInfo')
registerNoArgTool('videobuff_get_ui_state',  'getUIState',     'getUIState')
registerNoArgTool('videobuff_toggle_play',   'togglePlay',     'togglePlay')
registerNoArgTool('videobuff_undo',          'undo',           'undo')
registerNoArgTool('videobuff_redo',          'redo',           'redo')

// ── Tools with typed inputs ───────────────────────────────────

registerArgTool('videobuff_add_text_clip',    'addTextClip',    addTextClipInputSchema,    'addTextClip')
registerArgTool('videobuff_set_playhead',     'setPlayheadMs',  setPlayheadInputSchema,    'setPlayheadMs')
registerArgTool('videobuff_select_clip',      'selectClip',     selectClipInputSchema,     'selectClip')
registerArgTool('videobuff_remove_clip',      'removeClip',     removeClipInputSchema,     'removeClip')
registerArgTool('videobuff_split_clip',       'splitClip',      splitClipInputSchema,      'splitClip')
registerArgTool('videobuff_move_clip',        'moveClip',       moveClipInputSchema,       'moveClip')
registerArgTool('videobuff_trim_clip_start',  'trimClipStart',  trimClipStartInputSchema,  'trimClipStart')
registerArgTool('videobuff_trim_clip_end',    'trimClipEnd',    trimClipEndInputSchema,    'trimClipEnd')
registerArgTool('videobuff_update_text_clip', 'updateTextClip', updateTextClipInputSchema, 'updateTextClip')

// ── Phase 1: project settings & clip properties ──────────────

registerArgTool('videobuff_set_project_name',       'setProjectName',       setProjectNameInputSchema,       'setProjectName')
registerArgTool('videobuff_set_aspect_ratio',       'setAspectRatio',       setAspectRatioInputSchema,       'setAspectRatio')
registerArgTool('videobuff_update_clip_transform',  'updateClipTransform',  updateClipTransformInputSchema,  'updateClipTransform')
registerArgTool('videobuff_update_clip_color',      'updateClipColorGrade', updateClipColorGradeInputSchema, 'updateClipColorGrade')
registerArgTool('videobuff_update_clip_transition', 'updateClipTransition', updateClipTransitionInputSchema, 'updateClipTransition')
registerArgTool('videobuff_update_clip_volume',     'updateClipVolume',     updateClipVolumeInputSchema,     'updateClipVolume')
registerArgTool('videobuff_update_clip_speed',      'updateClipSpeed',      updateClipSpeedInputSchema,      'updateClipSpeed')
registerArgTool('videobuff_update_image_clip',      'updateImageClip',      updateImageClipInputSchema,      'updateImageClip')
registerArgTool('videobuff_update_image_clip_shadow', 'updateImageClipShadow', updateImageClipShadowInputSchema, 'updateImageClipShadow')
registerArgTool('videobuff_unlink_clip',            'unlinkClip',           unlinkClipInputSchema,           'unlinkClip')
registerArgTool('videobuff_relink_clip',            'relinkClip',           relinkClipInputSchema,           'relinkClip')

// ── Phase 2: per-edge transition / track move / audio effect ─

registerArgTool('videobuff_update_clip_transition_edge',    'updateClipTransitionEdge',    updateClipTransitionEdgeInputSchema,    'updateClipTransitionEdge')
registerArgTool('videobuff_clear_clip_transition_override', 'clearClipTransitionOverride', clearClipTransitionOverrideInputSchema, 'clearClipTransitionOverride')
registerArgTool('videobuff_move_clip_to_sibling_track',     'moveClipToSiblingTrack',      moveClipToSiblingTrackInputSchema,      'moveClipToSiblingTrack')
registerArgTool('videobuff_update_clip_audio_effect',       'updateClipAudioEffect',       updateClipAudioEffectInputSchema,       'updateClipAudioEffect')

// ── Asset import (special — drives hidden file input via Playwright) ─
//
// Unlike the `registerArgTool`-family tools which round-trip through
// `window.videobuff[method]`, this one uses `page.setInputFiles()` to
// trigger the MediaBrowser's real import pipeline (Demuxer parse +
// thumbnail gen + OPFS persistence). Reproducing that pipeline inside
// the automation API would duplicate ~200 lines of media handling,
// so we drive the existing UI path instead.
//
// Flow:
//  1. snapshot current asset IDs
//  2. setInputFiles → onChange → async handleFiles
//  3. poll getProjectInfo() until N new assets appear
//  4. return the new IDs so the caller can target clips by assetId
//
// `importAsset` in the store auto-places assets on the timeline, so
// no separate "addToTimeline" step is needed.

interface AssetSnapshot { id: string }

server.registerTool(
  'videobuff_import_assets',
  {
    description: operations.importAssets.description,
    inputSchema: importAssetsInputSchema.shape,
  },
  async (args: ToolArgs) => {
    try {
      const { page } = await session.get()
      const { paths } = args as { paths: string[] }

      const before = await page.evaluate(() => {
        const info = window.videobuff!.getProjectInfo() as { assets: { id: string }[] }
        return info.assets.map((a) => a.id)
      })
      const beforeSet = new Set(before)

      log(`importing ${paths.length} file(s)…`)
      await page.setInputFiles(MEDIA_IMPORT_INPUT_SELECTOR, paths)

      const deadline = Date.now() + IMPORT_POLL_TIMEOUT_MS
      while (Date.now() < deadline) {
        const current = await page.evaluate(() => {
          const info = window.videobuff!.getProjectInfo() as { assets: AssetSnapshot[] }
          return info.assets
        }) as AssetSnapshot[]
        const added = current.filter((a) => !beforeSet.has(a.id))
        if (added.length >= paths.length) {
          log(`imported ${added.length} asset(s)`)
          return textResult({ assetIds: added.map((a) => a.id) })
        }
        await new Promise((r) => setTimeout(r, IMPORT_POLL_INTERVAL_MS))
      }
      return errorResult(
        new Error(
          `import timeout: only saw some of ${paths.length} file(s) within ${IMPORT_POLL_TIMEOUT_MS}ms`,
        ),
      )
    } catch (e) {
      return errorResult(e)
    }
  },
)

// ── Export (special — progress bridge + temp-file emission) ──

type ExportProgress = {
  phase: string
  percent: number
  currentFrame: number
  totalFrames: number
  message: string
}

// Mutable progress handler — updated per-export so the CDP binding
// (which survives across exports on the same page) always routes to
// the *current* MCP notification channel.
let onExportProgress: ((p: ExportProgress) => void) | null = null

server.registerTool(
  'videobuff_export',
  {
    description: operations.exportToBlob.description,
    inputSchema: exportToBlobInputSchema.unwrap().shape,
  },
  async (args, extra) => {
    try {
      const { page } = await session.get()
      log('starting export…')
      const start = Date.now()
      const progressToken = extra._meta?.progressToken

      // Install progress bridge: browser → Node → MCP notification.
      // page.exposeFunction registers a CDP binding that persists for the
      // page lifetime, so we install it once and route through the mutable
      // `onExportProgress` reference (updated per-export call).
      onExportProgress = (p) => {
        log(`export progress: ${p.phase} ${p.percent}% (${p.currentFrame}/${p.totalFrames})`)
        if (progressToken !== undefined) {
          extra
            .sendNotification({
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: p.currentFrame,
                total: p.totalFrames,
                message: `${p.phase}: ${p.percent}% — ${p.message}`,
              },
            })
            .catch(() => { /* best-effort */ })
        }
      }
      try {
        await page.exposeFunction(
          '__videobuff_onProgress',
          (p: ExportProgress) => onExportProgress?.(p),
        )
      } catch {
        // Already registered from a previous export on this page — fine,
        // the mutable `onExportProgress` ensures the current handler is used.
      }

      const result = await page.evaluate(
        (input: Record<string, unknown>) => window.videobuff!.exportToBlob(input),
        args,
      )

      const elapsed = Date.now() - start
      log(`export completed in ${elapsed}ms (${result.byteLength} bytes)`)

      // Clear the handler so stale progress events from a hypothetical
      // concurrent call don't leak into the wrong MCP channel.
      onExportProgress = null

      // Decode base64 → Buffer → write to temp file
      const buf = Buffer.from(result.base64, 'base64')
      const outPath = join(
        tmpdir(),
        `${EXPORT_FILENAME_PREFIX}${Date.now()}${EXPORT_FILENAME_SUFFIX}`,
      )
      await writeFile(outPath, buf)

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              path: outPath,
              sizeBytes: buf.byteLength,
              durationMs: result.durationMs,
              mimeType: result.mimeType,
              elapsedMs: elapsed,
              settings: result.settings,
            }),
          },
          {
            type: 'resource' as const,
            resource: {
              uri: `file://${outPath}`,
              mimeType: result.mimeType || DEFAULT_VIDEO_MIME,
              text: `Exported MP4: ${outPath}`,
            },
          },
        ],
      }
    } catch (e) {
      onExportProgress = null
      return errorResult(e)
    }
  },
)

// ── Lifecycle ────────────────────────────────────────────────

function installSignalHandlers(): void {
  const handle = async () => {
    await session.shutdown()
    process.exit(0)
  }
  process.on('SIGINT', handle)
  process.on('SIGTERM', handle)
}

installSignalHandlers()

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  log('MCP server listening on stdio')
}

main().catch((e) => {
  log(`fatal: ${String(e)}`)
  process.exit(1)
})
