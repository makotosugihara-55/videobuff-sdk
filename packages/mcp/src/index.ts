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
import { writeFile, mkdtemp, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute, extname, sep } from 'node:path'
import {
  operations,
  // Only the schemas with bespoke (non-`registerArgTool`) registration
  // stay imported — `registerArgTool` now pulls input shapes straight
  // from `operations[op].input`, removing ~20 redundant imports.
  exportToBlobInputSchema,
  importAssetsInputSchema,
  type VideoBuffAutomationAPI,
} from '@videobuff/contracts'
import { VideoBuffSession, log } from '@videobuff/core'

type ToolArgs = Record<string, unknown>

// ── Constants ────────────────────────────────────────────────

const SERVER_NAME = 'videobuff'
const SERVER_VERSION = '0.1.0'
const EXPORT_TMPDIR_PREFIX = 'videobuff-export-'
const EXPORT_FILENAME = 'export.mp4'
const EXPORT_FILE_MODE = 0o600
const DEFAULT_VIDEO_MIME = 'video/mp4'

// ── Media-import confinement (importAssets hardening) ────────
//
// Two defenses layered on top of Zod's shape validation:
//
//  1. Extension allow-list — rejects anything that isn't a known
//     video/audio/image container. Stops a prompt-injected agent from
//     coaxing the server into reading `~/.ssh/id_rsa` or similar.
//
//  2. Optional `VIDEOBUFF_MEDIA_ROOT` env var — when set, every import
//     path must resolve (via `realpath`) to a file inside that root.
//     Symlinks are followed before the check, so symlink-escape is
//     blocked too. The default (unset) preserves the current dev-UX
//     where any absolute path works.
//
//  3. Size ceiling — rejects files above 4 GB to catch pathological
//     inputs that would OOM the browser's demuxer.
//
// All checks run on the Node side BEFORE `page.setInputFiles`, so a
// malicious call never reaches the browser context.
// Keep this set in sync with the web UI's MediaBrowser extension list
// (`src/components/editor/MediaBrowser.tsx` — VIDEO_EXTS / AUDIO_EXTS) so
// a file that a user can drag-drop into the UI is also importable via
// MCP. Image formats mirror what the browser's <img> element can decode.
const ALLOWED_MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  // video containers
  '.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v', '.ogv', '.3gp',
  // audio containers
  '.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.opus', '.weba',
  // image formats
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
])
const GiB = 1024 ** 3
const MAX_MEDIA_FILE_BYTES = 4 * GiB

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

// ── Path-safety helper (importAssets guard) ──────────────────

/**
 * Validate one absolute path against the confinement policy.
 *
 * Returns the resolved real path on success — callers should prefer
 * the returned value over the input so that subsequent operations see
 * the canonical form (same file regardless of symlinks / `..`).
 *
 * Throws `Error` with a descriptive message on any rejection.
 */
async function assertImportablePath(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new Error(`importAssets: path must be absolute (got: ${path})`)
  }
  const ext = extname(path).toLowerCase()
  if (!ALLOWED_MEDIA_EXTENSIONS.has(ext)) {
    throw new Error(
      `importAssets: disallowed file extension '${ext || '(none)'}' — ` +
      `allowed: ${[...ALLOWED_MEDIA_EXTENSIONS].join(', ')}`,
    )
  }
  // realpath() both resolves symlinks and verifies existence. If the
  // target doesn't exist it throws ENOENT, which short-circuits the rest
  // of the check.
  let real: string
  try {
    real = await realpath(path)
  } catch (e) {
    throw new Error(`importAssets: cannot resolve path '${path}' (${(e as Error).message})`)
  }
  // After realpath, re-check the extension so a symlink with an
  // allowed name can't point at a disallowed target (e.g. `foo.mp4`
  // → `/etc/shadow`).
  const realExt = extname(real).toLowerCase()
  if (!ALLOWED_MEDIA_EXTENSIONS.has(realExt)) {
    throw new Error(
      `importAssets: symlink target has disallowed extension '${realExt || '(none)'}'`,
    )
  }
  const root = process.env.VIDEOBUFF_MEDIA_ROOT
  if (root) {
    let rootReal: string
    try {
      rootReal = await realpath(root)
    } catch (e) {
      throw new Error(
        `importAssets: VIDEOBUFF_MEDIA_ROOT='${root}' is not a valid directory (${(e as Error).message})`,
      )
    }
    const withinRoot = real === rootReal || real.startsWith(rootReal + sep)
    if (!withinRoot) {
      throw new Error(
        `importAssets: path '${path}' resolves outside VIDEOBUFF_MEDIA_ROOT`,
      )
    }
  }
  const st = await stat(real)
  if (!st.isFile()) {
    throw new Error(`importAssets: '${path}' is not a regular file`)
  }
  if (st.size > MAX_MEDIA_FILE_BYTES) {
    throw new Error(
      `importAssets: '${path}' is ${st.size} bytes, exceeds ${MAX_MEDIA_FILE_BYTES} byte limit`,
    )
  }
  return real
}

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

/**
 * Only the string-valued keys of VideoBuffAutomationAPI.
 *
 * `keyof T` on an interface nominally returns only its declared property
 * names, but when `T` contains members whose argument types embed an
 * open index signature (`{ [key: string]: unknown }`) — which several of
 * our update* methods do to accept partial patches — TypeScript widens
 * `keyof T` to `string | number | symbol`. That number/symbol leak then
 * poisons the mapped type below and the `ArgMethod` parameter downstream
 * ("Type 'number' is not assignable to type 'string'").
 *
 * `Extract<keyof T, string>` strips the widening back to the actual
 * method names. The method names are all plain identifiers, so this is
 * safe and matches the runtime shape we'd get from `Object.keys` anyway.
 */
type ApiMethodName = Extract<keyof VideoBuffAutomationAPI, string>

/**
 * Methods on VideoBuffAutomationAPI that take no arguments.
 *
 * Hand-enumerated rather than derived by a conditional type. We tried
 * both `extends () => unknown` and `Parameters<…>['length'] extends 0`,
 * but TypeScript's bivariant parameter subtyping (former) swallows every
 * function into the no-arg bucket, and the stricter `Parameters`-based
 * version collapses to `never` in the mapped-type context — probably
 * because the outer distribution doesn't keep `VideoBuffAutomationAPI[K]`
 * concrete enough for `Parameters` to resolve. Hard-coding the list
 * keeps this source of truth next to the seven `registerNoArgTool` call
 * sites below, and the `extends ApiMethodName` constraint still catches
 * typos / stale names at compile time.
 */
type NoArgMethod = Extract<
  ApiMethodName,
  'ping' | 'getProjectInfo' | 'getUIState' | 'togglePlay'
        | 'undo' | 'redo' | 'resetProject'
>

/**
 * Method names eligible for `registerArgTool`: everything on the API
 * except the zero-arg methods and the constants / special tools that
 * have bespoke registration (`exportToBlob`).
 */
type ArgMethod = Exclude<
  ApiMethodName,
  NoArgMethod | 'ready' | 'version' | 'exportToBlob'
>

/**
 * Register a tool whose underlying API method takes zero arguments.
 *
 * `op` names both the entry in the operations registry (used for
 * description + validated input shape) AND the method invoked on
 * `window.videobuff`. Every auto-generated tool uses this 1:1 mapping,
 * which is why the helper takes one name instead of repeating it three
 * times at every call site.
 */
function registerNoArgTool(toolName: string, op: NoArgMethod): void {
  server.registerTool(
    toolName,
    { description: operations[op].description, inputSchema: {} },
    () =>
      withPage((page) =>
        page.evaluate(
          (m: string) => {
            type Invoker = Record<string, () => unknown>
            return (window.videobuff as unknown as Invoker)[m]!()
          },
          op,
        ),
      ),
  )
}

/**
 * Register a tool whose underlying API method takes a single object argument.
 *
 * The Zod input schema is pulled straight from `operations[op].input` —
 * the contracts package is the single source of truth for tool shapes.
 * See the `registerNoArgTool` doc for why `op` is one parameter, not
 * three.
 */
function registerArgTool(toolName: string, op: ArgMethod): void {
  server.registerTool(
    toolName,
    { description: operations[op].description, inputSchema: operations[op].input.shape },
    (args: ToolArgs) =>
      withPage((page) =>
        page.evaluate(
          ({ m, a }: { m: string; a: ToolArgs }) => {
            type Invoker = Record<string, (x: unknown) => unknown>
            return (window.videobuff as unknown as Invoker)[m]!(a)
          },
          { m: op, a: args },
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

registerNoArgTool('videobuff_ping',          'ping')
registerNoArgTool('videobuff_get_project',   'getProjectInfo')
registerNoArgTool('videobuff_get_ui_state',  'getUIState')
registerNoArgTool('videobuff_toggle_play',   'togglePlay')
registerNoArgTool('videobuff_undo',          'undo')
registerNoArgTool('videobuff_redo',          'redo')
registerNoArgTool('videobuff_reset_project', 'resetProject')

// ── Tools with typed inputs ───────────────────────────────────

registerArgTool('videobuff_add_text_clip',    'addTextClip')
registerArgTool('videobuff_set_playhead',     'setPlayheadMs')
registerArgTool('videobuff_select_clip',      'selectClip')
registerArgTool('videobuff_remove_clip',      'removeClip')
registerArgTool('videobuff_split_clip',       'splitClip')
registerArgTool('videobuff_move_clip',        'moveClip')
registerArgTool('videobuff_trim_clip_start',  'trimClipStart')
registerArgTool('videobuff_trim_clip_end',    'trimClipEnd')
registerArgTool('videobuff_update_text_clip', 'updateTextClip')

// ── Phase 1: project settings & clip properties ──────────────

registerArgTool('videobuff_set_project_name',         'setProjectName')
registerArgTool('videobuff_set_aspect_ratio',         'setAspectRatio')
registerArgTool('videobuff_update_clip_transform',    'updateClipTransform')
registerArgTool('videobuff_update_clip_color',        'updateClipColorGrade')
registerArgTool('videobuff_update_clip_transition',   'updateClipTransition')
registerArgTool('videobuff_update_clip_volume',       'updateClipVolume')
registerArgTool('videobuff_update_clip_speed',        'updateClipSpeed')
registerArgTool('videobuff_update_image_clip',        'updateImageClip')
registerArgTool('videobuff_update_image_clip_shadow', 'updateImageClipShadow')
registerArgTool('videobuff_link_clip',                'linkClip')

// ── Phase 2: track move / audio effect ──────────────────────
// (Transition base + per-edge set/clear are all handled by the unified
//  videobuff_update_clip_transition tool above.)

registerArgTool('videobuff_move_clip_to_sibling_track', 'moveClipToSiblingTrack')
registerArgTool('videobuff_update_clip_audio_effect',   'updateClipAudioEffect')

// ── Asset management ─────────────────────────────────────────

registerArgTool('videobuff_remove_asset',          'removeAsset')
registerArgTool('videobuff_add_asset_to_timeline', 'addAssetToTimeline')

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

      // Path-safety gate — every path must pass the extension allow-list,
      // confinement check, and size ceiling BEFORE the Playwright call
      // ever reads the file. `assertImportablePath` throws on rejection;
      // the `catch` at the bottom turns that into a structured errorResult.
      // Resolving to the canonical real path here means any symlink is
      // followed once on the Node side; Playwright then opens the same
      // inode a second time with no TOCTOU window worth exploiting (the
      // worst case is the user racing their own filesystem).
      const resolvedPaths: string[] = []
      for (const p of paths) {
        resolvedPaths.push(await assertImportablePath(p))
      }

      const before = await page.evaluate(() => {
        const info = window.videobuff!.getProjectInfo() as { assets: { id: string }[] }
        return info.assets.map((a) => a.id)
      })
      const beforeSet = new Set(before)

      log(`importing ${resolvedPaths.length} file(s)…`)
      await page.setInputFiles(MEDIA_IMPORT_INPUT_SELECTOR, resolvedPaths)

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
    inputSchema: exportToBlobInputSchema.shape,
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

      // Decode base64 → Buffer → write to a per-invocation temp directory.
      //
      // Security: `mkdtemp` creates a fresh directory with mode 0700
      // (umask-dependent, but Node ≥ v10.30 enforces 0700 on POSIX),
      // and we further chmod the MP4 to 0600 on write. Together this
      // prevents other local users on multi-tenant systems from reading
      // the exported file out of `/tmp`. The previous implementation wrote
      // directly into `os.tmpdir()` with the default umask (typically
      // 0644), which on Linux multi-user machines is world-readable.
      //
      // We do not clean up the directory — Claude Code needs the file
      // to persist long enough for the user to read/move it. OS temp
      // cleanup takes care of the rest on reboot.
      const buf = Buffer.from(result.base64, 'base64')
      const outDir = await mkdtemp(join(tmpdir(), EXPORT_TMPDIR_PREFIX))
      const outPath = join(outDir, EXPORT_FILENAME)
      await writeFile(outPath, buf, { mode: EXPORT_FILE_MODE })

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
  // Eagerly warm the Playwright session in parallel with the MCP
  // handshake. The first tool call then pays only the difference
  // between "Chromium launch + page.goto + window.videobuff.ready" and
  // "MCP handshake + listTools + first tool dispatch". In benchmark
  // runs the MCP handshake takes ~400–550ms and Chromium warm launch
  // takes ~500–1000ms, so the first tool call ends up ~0–500ms instead
  // of 580–2800ms.
  //
  // If warmup fails (e.g. dev server not running yet), VideoBuffSession
  // clears the stale promise so the first real tool call re-launches
  // and surfaces the error through errorResult — identical behaviour
  // to the pre-warmup code path, just earlier. Set VIDEOBUFF_LAZY=1 to
  // disable (useful for CI that only wants to validate the tool list).
  if (process.env.VIDEOBUFF_LAZY !== '1') {
    void session.get().catch(() => {
      // Intentionally swallowed — VideoBuffSession.get() has already
      // logged the failure and cleared its internal promise. The next
      // real `session.get()` from a tool call will retry and report.
    })
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
  log('MCP server listening on stdio')
}

main().catch((e) => {
  log(`fatal: ${String(e)}`)
  process.exit(1)
})
