#!/usr/bin/env -S tsx
/**
 * Dump the JSON schema the MCP server emits for every tool.
 * Used to find verbose fields in individual tool definitions.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const entry = resolve(here, '..', 'src', 'index.ts')

const env: Record<string, string> = {}
for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
env.VIDEOBUFF_TELEMETRY = '0'
env.VIDEOBUFF_LAZY = '1' // no Chromium launch needed for schema dump

const transport = new StdioClientTransport({ command: 'tsx', args: [entry], env, stderr: 'ignore' })
const client = new Client({ name: 'videobuff-schema-dump', version: '0.0.0' }, { capabilities: {} })

await client.connect(transport)
const { tools } = await client.listTools()
await client.close()

const target = process.argv[2] ?? 'videobuff_update_text_clip'
const tool = tools.find((t) => t.name === target)
if (!tool) {
  console.error(`tool not found: ${target}`)
  console.error('available:', tools.map((t) => t.name).join(', '))
  process.exit(1)
}
console.log(JSON.stringify(tool, null, 2))
console.log(`\n→ ${Buffer.byteLength(JSON.stringify(tool), 'utf8')} bytes`)
