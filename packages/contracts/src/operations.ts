/**
 * Operation registry — maps tool names to their input/output schemas.
 *
 * The MCP server and CLI auto-generate tools from this registry.
 * Adding a new operation here automatically exposes it everywhere.
 */

import { z } from 'zod'
import {
  exportToBlobInputSchema,
  exportToBlobResultSchema,
  addTextClipInputSchema,
  addTextClipResultSchema,
  setPlayheadInputSchema,
  setPlayheadResultSchema,
  pingResultSchema,
  togglePlayResultSchema,
} from './schemas.js'

export interface OperationDef<I extends z.ZodTypeAny = z.ZodTypeAny, O extends z.ZodTypeAny = z.ZodTypeAny> {
  description: string
  input: I
  output: O
}

/**
 * All automation operations, keyed by their tool name suffix.
 * MCP tools are prefixed with `videobuff_` (e.g. `videobuff_ping`).
 */
export const operations = {
  ping: {
    description: 'Liveness probe. Opens the editor tab on first call.',
    input: z.object({}),
    output: pingResultSchema,
  },
  getProjectInfo: {
    description: 'Project snapshot: durationMs and per-track summary.',
    input: z.object({}),
    output: z.unknown(),
  },
  getUIState: {
    description: 'UI state: playheadMs, isPlaying, activeTool, selectedClipId.',
    input: z.object({}),
    output: z.unknown(),
  },
  addTextClip: {
    description: 'Add a text clip at startMs. Returns the new clipId.',
    input: addTextClipInputSchema,
    output: addTextClipResultSchema,
  },
  setPlayheadMs: {
    description: 'Move the playhead to the given time in ms.',
    input: setPlayheadInputSchema,
    output: setPlayheadResultSchema,
  },
  togglePlay: {
    description: 'Toggle play/pause. Returns the new isPlaying state.',
    input: z.object({}),
    output: togglePlayResultSchema,
  },
  exportToBlob: {
    description: 'Run the full export pipeline. Returns MP4 as base64.',
    input: exportToBlobInputSchema,
    output: exportToBlobResultSchema,
  },
} as const satisfies Record<string, OperationDef>

export type OperationName = keyof typeof operations
