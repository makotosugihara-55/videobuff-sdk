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
} from '@videobuff/contracts'
import { VideoBuffSession, log } from '@videobuff/core'

// Re-export log from core uses stderr (never stdout — that's the JSON-RPC channel)

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

/**
 * Every tool follows the same pattern: get a Page, run page.evaluate, return.
 * This helper hides the try/catch + session wiring.
 */
const session = new VideoBuffSession()

// Mutable progress handler — updated per-export so the CDP binding
// (which survives across exports on the same page) always routes to
// the *current* MCP notification channel.
let onExportProgress: ((p: ExportProgress) => void) | null = null

type ExportProgress = {
  phase: string
  percent: number
  currentFrame: number
  totalFrames: number
  message: string
}

async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<ToolResult> {
  try {
    const { page } = await session.get()
    return textResult(await fn(page))
  } catch (e) {
    return errorResult(e)
  }
}

// ── MCP server + tool registrations ──────────────────────────

const server = new McpServer(
  { name: 'videobuff', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

server.registerTool(
  'videobuff_ping',
  { description: operations.ping.description, inputSchema: {} },
  () => withPage(page => page.evaluate(() => window.videobuff!.ping())),
)

server.registerTool(
  'videobuff_get_project',
  { description: operations.getProjectInfo.description, inputSchema: {} },
  () => withPage(page => page.evaluate(() => window.videobuff!.getProjectInfo())),
)

server.registerTool(
  'videobuff_get_ui_state',
  { description: operations.getUIState.description, inputSchema: {} },
  () => withPage(page => page.evaluate(() => window.videobuff!.getUIState())),
)

server.registerTool(
  'videobuff_add_text_clip',
  {
    description: operations.addTextClip.description,
    inputSchema: addTextClipInputSchema.shape,
  },
  ({ startMs }) =>
    withPage(page =>
      page.evaluate((ms: number) => window.videobuff!.addTextClip({ startMs: ms }), startMs),
    ),
)

server.registerTool(
  'videobuff_set_playhead',
  {
    description: operations.setPlayheadMs.description,
    inputSchema: setPlayheadInputSchema.shape,
  },
  ({ ms }) =>
    withPage(page =>
      page.evaluate((m: number) => window.videobuff!.setPlayheadMs({ ms: m }), ms),
    ),
)

server.registerTool(
  'videobuff_toggle_play',
  { description: operations.togglePlay.description, inputSchema: {} },
  () => withPage(page => page.evaluate(() => window.videobuff!.togglePlay())),
)

// ── Clip selection ──────────────────────────────────────────

server.registerTool(
  'videobuff_select_clip',
  {
    description: operations.selectClip.description,
    inputSchema: selectClipInputSchema.shape,
  },
  ({ clipId }) =>
    withPage(page =>
      page.evaluate((id: string | null) => window.videobuff!.selectClip({ clipId: id }), clipId),
    ),
)

// ── Clip CRUD ───────────────────────────────────────────────

server.registerTool(
  'videobuff_remove_clip',
  {
    description: operations.removeClip.description,
    inputSchema: removeClipInputSchema.shape,
  },
  ({ clipId }) =>
    withPage(page =>
      page.evaluate((id: string) => window.videobuff!.removeClip({ clipId: id }), clipId),
    ),
)

server.registerTool(
  'videobuff_split_clip',
  {
    description: operations.splitClip.description,
    inputSchema: splitClipInputSchema.shape,
  },
  ({ clipId, splitAtMs }) =>
    withPage(page =>
      page.evaluate(
        (args: { clipId: string; splitAtMs: number }) => window.videobuff!.splitClip(args),
        { clipId, splitAtMs },
      ),
    ),
)

server.registerTool(
  'videobuff_move_clip',
  {
    description: operations.moveClip.description,
    inputSchema: moveClipInputSchema.shape,
  },
  ({ clipId, newStartMs }) =>
    withPage(page =>
      page.evaluate(
        (args: { clipId: string; newStartMs: number }) => window.videobuff!.moveClip(args),
        { clipId, newStartMs },
      ),
    ),
)

server.registerTool(
  'videobuff_trim_clip_start',
  {
    description: operations.trimClipStart.description,
    inputSchema: trimClipStartInputSchema.shape,
  },
  ({ clipId, newStartMs }) =>
    withPage(page =>
      page.evaluate(
        (args: { clipId: string; newStartMs: number }) => window.videobuff!.trimClipStart(args),
        { clipId, newStartMs },
      ),
    ),
)

server.registerTool(
  'videobuff_trim_clip_end',
  {
    description: operations.trimClipEnd.description,
    inputSchema: trimClipEndInputSchema.shape,
  },
  ({ clipId, newEndMs }) =>
    withPage(page =>
      page.evaluate(
        (args: { clipId: string; newEndMs: number }) => window.videobuff!.trimClipEnd(args),
        { clipId, newEndMs },
      ),
    ),
)

// ── Text clip editing ───────────────────────────────────────

server.registerTool(
  'videobuff_update_text_clip',
  {
    description: operations.updateTextClip.description,
    inputSchema: updateTextClipInputSchema.shape,
  },
  ({ clipId, ...patch }) =>
    withPage(page =>
      page.evaluate(
        (args: { clipId: string; patch: Record<string, unknown> }) =>
          window.videobuff!.updateTextClip(args),
        { clipId, patch },
      ),
    ),
)

// ── Undo / Redo ─────────────────────────────────────────────

server.registerTool(
  'videobuff_undo',
  { description: operations.undo.description, inputSchema: {} },
  () => withPage(page => page.evaluate(() => window.videobuff!.undo())),
)

server.registerTool(
  'videobuff_redo',
  { description: operations.redo.description, inputSchema: {} },
  () => withPage(page => page.evaluate(() => window.videobuff!.redo())),
)

// ── Export ───────────────────────────────────────────────────

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
          extra.sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken,
              progress: p.currentFrame,
              total: p.totalFrames,
              message: `${p.phase}: ${p.percent}% — ${p.message}`,
            },
          }).catch(() => { /* best-effort */ })
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
      const outPath = join(tmpdir(), `videobuff-export-${Date.now()}.mp4`)
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
              mimeType: result.mimeType || 'video/mp4',
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
  const handle = async () => { await session.shutdown(); process.exit(0) }
  process.on('SIGINT', handle)
  process.on('SIGTERM', handle)
}

installSignalHandlers()

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  log('MCP server listening on stdio')
}

main().catch(e => {
  log(`fatal: ${String(e)}`)
  process.exit(1)
})
