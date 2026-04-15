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
import { z } from 'zod'

import { operations, EXPORT_LIMITS } from '@videobuff/contracts'
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
    inputSchema: {
      startMs: z.number().int().min(0).describe('Start time in ms (>= 0)'),
    },
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
    inputSchema: {
      ms: z.number().int().min(0).describe('Target time in ms'),
    },
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

server.registerTool(
  'videobuff_export',
  {
    description: operations.exportToBlob.description,
    inputSchema: {
      width: z.number().int().min(EXPORT_LIMITS.width.min).max(EXPORT_LIMITS.width.max)
        .describe(`Width in px [${EXPORT_LIMITS.width.min}–${EXPORT_LIMITS.width.max}]`).optional(),
      height: z.number().int().min(EXPORT_LIMITS.height.min).max(EXPORT_LIMITS.height.max)
        .describe(`Height in px [${EXPORT_LIMITS.height.min}–${EXPORT_LIMITS.height.max}]`).optional(),
      fps: z.number().int().min(EXPORT_LIMITS.fps.min).max(EXPORT_LIMITS.fps.max)
        .describe(`Frames per second [${EXPORT_LIMITS.fps.min}–${EXPORT_LIMITS.fps.max}]`).optional(),
      videoCodec: z.enum(['h264', 'h265']).describe('Video codec').optional(),
      videoBitrate: z.number().int().min(EXPORT_LIMITS.videoBitrate.min).max(EXPORT_LIMITS.videoBitrate.max)
        .describe('Video bitrate in bps').optional(),
      loudnessTarget: z.enum(['off', 'webSns', 'applePodcast', 'broadcast'])
        .describe('Loudness normalization target').optional(),
      timeoutMs: z.number().int().min(EXPORT_LIMITS.timeoutMs.min).max(EXPORT_LIMITS.timeoutMs.max)
        .describe('Timeout in ms (default 5 min)').optional(),
    },
  },
  async (args) => {
    try {
      const { page } = await session.get()
      log('starting export…')
      const start = Date.now()

      const result = await page.evaluate(
        (input: Record<string, unknown>) => window.videobuff!.exportToBlob(input),
        args,
      )

      const elapsed = Date.now() - start
      log(`export completed in ${elapsed}ms (${result.byteLength} bytes)`)

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
