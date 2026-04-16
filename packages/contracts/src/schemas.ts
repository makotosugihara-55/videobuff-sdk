/**
 * Zod schemas for VideoBuff automation API inputs and outputs.
 *
 * These schemas are the authoritative validation layer — both the
 * web-side ACL and the SDK-side tools validate through these.
 */

import { z } from 'zod'

// ── Enums ──────────────────────────────────────────────────────

export const videoCodecSchema = z.enum(['h264', 'h265'])
export const loudnessTargetSchema = z.enum(['off', 'webSns', 'applePodcast', 'broadcast'])

// ── Export limits (bounds for numeric fields) ──────────────────

export const EXPORT_LIMITS = {
  width:        { min: 16, max: 3840 },      // up to 4K
  height:       { min: 16, max: 2160 },
  fps:          { min: 1,  max: 120 },
  videoBitrate: { min: 100_000, max: 100_000_000 }, // 100 kbps – 100 Mbps
  timeoutMs:    { min: 1_000,   max: 1_800_000 },   // 1 s – 30 min
} as const

// ── Input schemas ──────────────────────────────────────────────

// z.coerce.number() accepts both JSON numbers and numeric strings. This
// matters because some MCP clients (incl. Claude Code) occasionally
// stringify numeric tool args during JSON-RPC serialization. Coercing at
// the schema boundary keeps the public API LLM-friendly without leaking
// string handling into domain code.
const intMs = () => z.coerce.number().int().min(0)

export const exportToBlobInputSchema = z.object({
  width:          z.coerce.number().int().min(EXPORT_LIMITS.width.min).max(EXPORT_LIMITS.width.max).optional(),
  height:         z.coerce.number().int().min(EXPORT_LIMITS.height.min).max(EXPORT_LIMITS.height.max).optional(),
  fps:            z.coerce.number().int().min(EXPORT_LIMITS.fps.min).max(EXPORT_LIMITS.fps.max).optional(),
  videoCodec:     videoCodecSchema.optional(),
  videoBitrate:   z.coerce.number().int().min(EXPORT_LIMITS.videoBitrate.min).max(EXPORT_LIMITS.videoBitrate.max).optional(),
  loudnessTarget: loudnessTargetSchema.optional(),
  timeoutMs:      z.coerce.number().int().min(EXPORT_LIMITS.timeoutMs.min).max(EXPORT_LIMITS.timeoutMs.max).optional(),
}).optional()

export const addTextClipInputSchema = z.object({
  startMs: intMs(),
})

export const setPlayheadInputSchema = z.object({
  ms: intMs(),
})

export const selectClipInputSchema = z.object({
  clipId: z.string().nullable(),
})

export const removeClipInputSchema = z.object({
  clipId: z.string(),
})

export const splitClipInputSchema = z.object({
  clipId: z.string(),
  splitAtMs: intMs(),
})

export const moveClipInputSchema = z.object({
  clipId: z.string(),
  newStartMs: intMs(),
})

export const trimClipStartInputSchema = z.object({
  clipId: z.string(),
  newStartMs: intMs(),
})

export const trimClipEndInputSchema = z.object({
  clipId: z.string(),
  newEndMs: intMs(),
})

export const updateTextClipInputSchema = z.object({
  clipId: z.string(),
  text: z.string().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.coerce.number().min(1).optional(),
  color: z.string().optional(),
  bold: z.coerce.boolean().optional(),
  italic: z.coerce.boolean().optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(),
  positionX: z.coerce.number().optional(),
  positionY: z.coerce.number().optional(),
  backgroundColor: z.string().optional(),
  outlineColor: z.string().optional(),
  outlineWidth: z.coerce.number().min(0).optional(),
  shadowColor: z.string().optional(),
  shadowBlur: z.coerce.number().min(0).optional(),
  shadowOffsetX: z.coerce.number().optional(),
  shadowOffsetY: z.coerce.number().optional(),
  opacity: z.coerce.number().min(0).max(1).optional(),
})

// ── Output schemas ─────────────────────────────────────────────

export const exportSettingsSchema = z.object({
  width: z.number(),
  height: z.number(),
  fps: z.number(),
  videoCodec: videoCodecSchema,
  videoBitrate: z.number(),
  audioBitrate: z.number(),
  audioSampleRate: z.number(),
  loudnessTarget: loudnessTargetSchema,
  previewFrameWidth: z.number(),
  previewFrameHeight: z.number(),
})

export const exportToBlobResultSchema = z.object({
  base64: z.string(),
  byteLength: z.number().int().min(0),
  mimeType: z.string(),
  durationMs: z.number().min(0),
  settings: exportSettingsSchema,
})
export type ExportToBlobResult = z.infer<typeof exportToBlobResultSchema>

export const pingResultSchema = z.object({
  pong: z.literal(true),
  time: z.number(),
})

export const addTextClipResultSchema = z.object({
  clipId: z.string().nullable(),
})

export const setPlayheadResultSchema = z.object({
  playheadMs: z.number(),
})

export const togglePlayResultSchema = z.object({
  isPlaying: z.boolean(),
})

export const okResultSchema = z.object({ ok: z.literal(true) })

export const selectClipResultSchema = z.object({
  selectedClipId: z.string().nullable(),
})
