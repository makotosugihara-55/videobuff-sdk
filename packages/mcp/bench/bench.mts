#!/usr/bin/env -S tsx
/**
 * MCP latency benchmark.
 *
 * Spawns `tsx src/index.ts` over stdio (the same way Claude Code spawns
 * the server) and times:
 *
 *   - MCP handshake           (spawn → initialize() completes)
 *   - Cold first tool call    (initialize → first `videobuff_ping` returns)
 *                             Dominated by Chromium launch + page.goto +
 *                             waiting for `window.videobuff.ready`.
 *   - Warm per-call latency   (subsequent calls; pure CDP roundtrip)
 *
 * We run three no-arg tools to see whether the per-call cost depends on
 * what the tool does inside the page. `ping` is a constant return, the
 * others pull store state — if their median shifts meaningfully above
 * ping's, the bottleneck is inside `window.videobuff`, not the CDP hop.
 *
 * Telemetry is disabled (VIDEOBUFF_TELEMETRY=0) so the bench doesn't
 * POST to videobuff.com and our numbers aren't polluted by network I/O.
 *
 * Usage:
 *   pnpm --filter @videobuff/mcp bench              # default (dev server on :3000)
 *   VIDEOBUFF_URL=http://localhost:3000 pnpm ... bench
 *   BENCH_ITERATIONS=20 pnpm ... bench
 *   BENCH_LABEL=after pnpm ... bench > after.txt    # for before/after compare
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ITER = Number(process.env.BENCH_ITERATIONS ?? 10)
const LABEL = process.env.BENCH_LABEL ?? 'baseline'
const TOOLS = ['videobuff_ping', 'videobuff_get_ui_state', 'videobuff_get_project'] as const

// ── stats helpers ────────────────────────────────────────────

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx]!
}

function summarize(label: string, samples: number[]): Record<string, number | string> {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    tool: label,
    n: samples.length,
    min: Math.round(sorted[0] ?? 0),
    p50: Math.round(pct(sorted, 0.5)),
    p95: Math.round(pct(sorted, 0.95)),
    max: Math.round(sorted[sorted.length - 1] ?? 0),
    mean: Math.round(samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length)),
  }
}

// ── bench ────────────────────────────────────────────────────

async function main() {
  const here = dirname(fileURLToPath(import.meta.url))
  const entry = resolve(here, '..', 'src', 'index.ts')

  // Pass-through of process.env with telemetry disabled so POSTs to
  // videobuff.com don't skew numbers. `HEADFUL` is left unset — defaults
  // to headless, which is what we want for repeatable measurements.
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }
  env.VIDEOBUFF_TELEMETRY = '0'

  console.error(`[bench] label=${LABEL} iter=${ITER} entry=${entry}`)
  console.error(`[bench] editor=${env.VIDEOBUFF_URL ?? '(default http://localhost:3000)'}`)

  const transport = new StdioClientTransport({
    command: 'tsx',
    args: [entry],
    env,
    stderr: 'inherit',
  })
  const client = new Client({ name: 'videobuff-bench', version: '0.0.0' }, { capabilities: {} })

  const tSpawn = performance.now()
  await client.connect(transport)
  const tHandshake = performance.now()

  // Tool-schema payload size — this is exactly what Claude Code pulls
  // into its context on every session. Burning tokens here is paid by
  // every user request, not just tool calls.
  const toolsListed = await client.listTools()
  const toolsJson = JSON.stringify(toolsListed)
  const toolsBytes = Buffer.byteLength(toolsJson, 'utf8')
  // Per-tool sizes so we can spot expensive outliers.
  const perToolBytes = toolsListed.tools.map((t) => ({
    name: t.name,
    bytes: Buffer.byteLength(JSON.stringify(t), 'utf8'),
  })).sort((a, b) => b.bytes - a.bytes)

  // Cold first call — triggers the lazy Chromium launch + page.goto + waitForFunction.
  const tColdStart = performance.now()
  const firstPing = await client.callTool({ name: 'videobuff_ping', arguments: {} })
  const tColdEnd = performance.now()
  const pingBytes = Buffer.byteLength(JSON.stringify(firstPing), 'utf8')

  // Response-size samples for the two "read" tools the LLM calls most.
  const uiState = await client.callTool({ name: 'videobuff_get_ui_state', arguments: {} })
  const uiBytes = Buffer.byteLength(JSON.stringify(uiState), 'utf8')
  const projectInfo = await client.callTool({ name: 'videobuff_get_project', arguments: {} })
  const projectBytes = Buffer.byteLength(JSON.stringify(projectInfo), 'utf8')

  const samples: Record<string, number[]> = {}
  for (const tool of TOOLS) samples[tool] = []

  // Warm phase — ITER iterations of each tool, interleaved so a GC pause
  // in the middle doesn't bias one tool's tail.
  for (let i = 0; i < ITER; i++) {
    for (const tool of TOOLS) {
      const t0 = performance.now()
      await client.callTool({ name: tool, arguments: {} })
      const dt = performance.now() - t0
      samples[tool]!.push(dt)
    }
  }

  // Clean shutdown — let the MCP server tear down Playwright properly.
  await client.close()

  // ── report ────────────────────────────────────────────────

  const handshakeMs = Math.round(tHandshake - tSpawn)
  const coldMs = Math.round(tColdEnd - tColdStart)

  console.log()
  console.log(`=== MCP bench — ${LABEL} ===`)
  console.log(`MCP handshake:      ${handshakeMs} ms`)
  console.log(`Cold first tool:    ${coldMs} ms  (includes Chromium launch + editor ready)`)
  console.log()
  console.log('Warm per-call latency (ms):')
  console.log('tool                       n   min   p50   p95   max  mean')
  console.log('-'.repeat(62))
  for (const tool of TOOLS) {
    const s = summarize(tool, samples[tool]!)
    console.log(
      `${String(s.tool).padEnd(26)} ${String(s.n).padStart(2)}  ` +
      `${String(s.min).padStart(4)}  ${String(s.p50).padStart(4)}  ` +
      `${String(s.p95).padStart(4)}  ${String(s.max).padStart(4)}  ` +
      `${String(s.mean).padStart(4)}`,
    )
  }

  // Rough token estimate — ~4 chars per token for JSON-ish English/symbol
  // content. Good enough for tracking changes; never trust absolute values.
  const toTokens = (bytes: number) => Math.round(bytes / 4)

  console.log()
  console.log('Payload sizes (what Claude actually sees):')
  console.log(`  tools/list total:  ${toolsBytes.toString().padStart(6)} bytes  (~${toTokens(toolsBytes)} tokens)`)
  console.log(`  ping response:     ${pingBytes.toString().padStart(6)} bytes  (~${toTokens(pingBytes)} tokens)`)
  console.log(`  get_ui_state:      ${uiBytes.toString().padStart(6)} bytes  (~${toTokens(uiBytes)} tokens)`)
  console.log(`  get_project:       ${projectBytes.toString().padStart(6)} bytes  (~${toTokens(projectBytes)} tokens)`)
  console.log()
  console.log('Top 10 tools by schema size:')
  for (const t of perToolBytes.slice(0, 10)) {
    console.log(`  ${t.name.padEnd(42)} ${String(t.bytes).padStart(5)} bytes`)
  }
  console.log()
  console.log(JSON.stringify({
    label: LABEL,
    iter: ITER,
    handshake_ms: handshakeMs,
    cold_first_tool_ms: coldMs,
    payload_bytes: {
      tools_list: toolsBytes,
      ping: pingBytes,
      ui_state: uiBytes,
      project: projectBytes,
    },
    per_tool_bytes: perToolBytes,
    warm: Object.fromEntries(TOOLS.map((t) => [t, summarize(t, samples[t]!)])),
  }))
}

main().catch((e) => {
  console.error('[bench] failed:', e)
  process.exit(1)
})
