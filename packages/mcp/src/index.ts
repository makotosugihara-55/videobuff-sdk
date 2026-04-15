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
import { z } from 'zod'

import { operations } from '@videobuff/contracts'
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
