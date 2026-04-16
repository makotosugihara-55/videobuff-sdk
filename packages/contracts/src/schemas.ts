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
export const aspectRatioSchema = z.enum(['16:9', '9:16', '1:1', '4:3'])
export const transitionTypeSchema = z.enum([
  'none', 'dissolve', 'fade-black', 'fade-white', 'blur', 'zoom', 'wipe', 'typewriter',
])
export const blendModeSchema = z.enum([
  'normal', 'multiply', 'screen', 'overlay',
  'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion',
])
export const textAlignSchema = z.enum(['left', 'center', 'right'])

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

/**
 * Safe boolean coercion — accepts real booleans and the exact strings
 * `"true"` / `"false"`, rejecting everything else. Avoids the
 * `z.coerce.boolean()` foot-gun where `Boolean("false") === true`
 * turns a stringified `false` into `true` silently.
 *
 * Needed because some MCP clients (incl. Claude Code) occasionally
 * send booleans as strings over JSON-RPC.
 */
const bool = () =>
  z.preprocess((v) => {
    if (v === 'true') return true
    if (v === 'false') return false
    return v
  }, z.boolean())

// Common numeric-range helpers used across the clip-update schemas.
// These encode recurring editor-domain ranges as single-call builders so
// individual schema definitions read declaratively. Scoped to this file
// (not exported) because they're implementation detail — the boundary
// contract is the input schemas themselves.
const num = () => z.coerce.number()
const bipolar100  = () => num().min(-100).max(100) // -100..+100 (most color dials)
const unipolar100 = () => num().min(0).max(100)    // 0..100 (opacity %, vignette, …)
const unit        = () => num().min(0).max(1)      // 0..1 (volume, normalized range)

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
  fontSize: num().min(1).optional(),
  color: z.string().optional(),
  bold: bool().optional(),
  italic: bool().optional(),
  textAlign: textAlignSchema.optional(),
  positionX: num().optional(),
  positionY: num().optional(),
  backgroundColor: z.string().optional(),
  outlineColor: z.string().optional(),
  outlineWidth: num().min(0).optional(),
  shadowColor: z.string().optional(),
  shadowBlur: num().min(0).optional(),
  shadowOffsetX: num().optional(),
  shadowOffsetY: num().optional(),
  opacity: unipolar100().optional(),
})

// ── Phase 1: project / clip properties ─────────────────────────

export const setProjectNameInputSchema = z.object({
  name: z.string().min(1).max(200),
})

export const setAspectRatioInputSchema = z.object({
  aspectRatio: aspectRatioSchema,
})

/** Transform fields — positions in px from center, scales in %, crops 0-50%. */
export const updateClipTransformInputSchema = z.object({
  clipId: z.string(),
  positionX: num().optional(),
  positionY: num().optional(),
  rotation: num().min(-180).max(180).optional(),
  opacity: unipolar100().optional(),
  scaleX: num().min(0).max(200).optional(),
  scaleY: num().min(0).max(200).optional(),
  keepAspectRatio: bool().optional(),
  cropTop: num().min(0).max(50).optional(),
  cropBottom: num().min(0).max(50).optional(),
  cropLeft: num().min(0).max(50).optional(),
  cropRight: num().min(0).max(50).optional(),
})

/** ColorGrade — bipolar -100..+100 basics, unipolar 0..100 detail/effect. */
export const updateClipColorGradeInputSchema = z.object({
  clipId: z.string(),
  exposure:       bipolar100().optional(),
  contrast:       bipolar100().optional(),
  highlights:     bipolar100().optional(),
  shadows:        bipolar100().optional(),
  temperature:    bipolar100().optional(),
  tint:           bipolar100().optional(),
  vibrance:       bipolar100().optional(),
  saturation:     bipolar100().optional(),
  fadedFilm:      unipolar100().optional(),
  sharpness:      unipolar100().optional(),
  vignetteAmount: unipolar100().optional(),
  vignetteBlur:   unipolar100().optional(),
  blur:           unipolar100().optional(),
})

/** Base transition (shared by both edges). durationMs is clamped 100..3000. */
export const updateClipTransitionInputSchema = z.object({
  clipId: z.string(),
  type: transitionTypeSchema.optional(),
  durationMs: num().int().min(100).max(3000).optional(),
})

export const updateClipVolumeInputSchema = z.object({
  clipId: z.string(),
  volume: unit(),
})

/** Playback speed + optional ramp (ease-in/out between rangeStart..rangeEnd). */
export const updateClipSpeedInputSchema = z.object({
  clipId: z.string(),
  rate: num().min(0.1).max(10).optional(),
  ramp: bool().optional(),
  rampDurationMs: intMs().optional(),
  preservePitch: bool().optional(),
  rangeStart: unit().optional(),
  rangeEnd:   unit().optional(),
})

/**
 * Image-clip top-level fields.
 *
 * Shadow editing is intentionally deferred — the store merges via
 * `Partial<ImageClip>`, which means passing a partial `shadow` here
 * would clobber unspecified fields. A dedicated `updateImageClipShadow`
 * tool will land in a follow-up batch once the per-field merge shape
 * is settled.
 */
export const updateImageClipInputSchema = z.object({
  clipId: z.string(),
  opacity: unipolar100().optional(),
  blendMode: blendModeSchema.optional(),
  borderRadius: num().min(0).max(50).optional(),
})

export const unlinkClipInputSchema = z.object({
  clipId: z.string(),
})

export const relinkClipInputSchema = z.object({
  clipId: z.string(),
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
