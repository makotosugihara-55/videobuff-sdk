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
  selectClipInputSchema,
  selectClipResultSchema,
  removeClipInputSchema,
  splitClipInputSchema,
  moveClipInputSchema,
  trimClipStartInputSchema,
  trimClipEndInputSchema,
  updateTextClipInputSchema,
  okResultSchema,
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
  selectClip: {
    description: 'Select a clip by ID, or null to deselect.',
    input: selectClipInputSchema,
    output: selectClipResultSchema,
  },
  removeClip: {
    description: 'Remove a clip from the timeline.',
    input: removeClipInputSchema,
    output: okResultSchema,
  },
  splitClip: {
    description: 'Split a clip into two at the given time.',
    input: splitClipInputSchema,
    output: okResultSchema,
  },
  moveClip: {
    description: 'Move a clip to a new start time.',
    input: moveClipInputSchema,
    output: okResultSchema,
  },
  trimClipStart: {
    description: 'Trim the start edge of a clip.',
    input: trimClipStartInputSchema,
    output: okResultSchema,
  },
  trimClipEnd: {
    description: 'Trim the end edge of a clip.',
    input: trimClipEndInputSchema,
    output: okResultSchema,
  },
  updateTextClip: {
    description: 'Update text clip properties (font, color, position, etc.).',
    input: updateTextClipInputSchema,
    output: okResultSchema,
  },
  undo: {
    description: 'Undo the last action.',
    input: z.object({}),
    output: okResultSchema,
  },
  redo: {
    description: 'Redo the last undone action.',
    input: z.object({}),
    output: okResultSchema,
  },
} as const satisfies Record<string, OperationDef>

export type OperationName = keyof typeof operations
