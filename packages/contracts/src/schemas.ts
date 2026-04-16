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
export const transitionEdgeSchema = z.enum(['in', 'out'])
export const siblingDirectionSchema = z.enum(['up', 'down'])

// ── Numeric limits (bounds for validated fields) ───────────────
//
// Only ranges used 2+ times live here. Single-use ranges stay inline
// at their schema — centralising them would force readers to jump
// between files for no reuse benefit. When a new schema needs one of
// these ranges, promote it rather than redefining.

export const EXPORT_LIMITS = {
  width:        { min: 16, max: 3840 },      // up to 4K
  height:       { min: 16, max: 2160 },
  fps:          { min: 1,  max: 120 },
  videoBitrate: { min: 100_000, max: 100_000_000 }, // 100 kbps – 100 Mbps
  timeoutMs:    { min: 1_000,   max: 1_800_000 },   // 1 s – 30 min
} as const

export const CLIP_LIMITS = {
  transitionDurationMs: { min: 100, max: 3000 }, // base + per-edge overrides
  scalePct:             { min: 0,   max: 200 },  // scaleX / scaleY
  cropPct:              { min: 0,   max: 50  },  // cropTop / Bottom / Left / Right
  shadowOffsetPx:       { min: -50, max: 50  },  // image shadow offsetX / offsetY
  rotationDeg:          { min: -180, max: 180 }, // clip rotation
  speedRate:            { min: 0.1, max: 10  },  // playback speed multiplier
  textFontSize:         { min: 1,   max: 1000 }, // text-clip font size (px)
  textOutline:          { min: 0,   max: 100 },  // text-clip outline width + shadow blur
  textShadowOffsetPx:   { min: -1000, max: 1000 }, // text-clip shadow offsetX / offsetY
  imageBorderRadius:    { min: 0,   max: 50  },  // image-clip borderRadius (px)
  compThresholdDb:      { min: -50, max: 0   },  // compressor threshold
  compRatio:            { min: 1,   max: 20  },  // compressor ratio
  noiseGateDb:          { min: -100, max: 0  },  // noise gate floor (-100 = off)
} as const

/**
 * Hard caps on user-supplied string lengths.
 *
 * These are wide enough for any realistic editing workflow but tight
 * enough that an attacker can't smuggle a multi-kilobyte prompt-injection
 * payload through a single field. Anything exceeding the cap is rejected
 * at the schema boundary — the web-side `untrusted()` snapshot wrapper
 * provides the second layer of defense (truncate + tag) for strings
 * that slip through via other paths (OPFS restore, direct store API).
 *
 *  - projectName:   100 chars  (title field — no legit use case beyond a title)
 *  - textClipText:  5_000      (multi-paragraph lower-thirds are fine; a novel is not)
 *  - fontFamily:    100        (real font names are short)
 *  - colorString:   64         (any reasonable hex/rgba/hsla fits)
 *
 * When a user legitimately hits a cap, they'll want to widen it. Leave
 * the existing values alone and add a new key rather than revising in
 * place, so existing clients stay predictable.
 */
export const STRING_LIMITS = {
  projectName:  { min: 1, max: 100 },
  textClipText: { min: 0, max: 5_000 },
  fontFamily:   { min: 1, max: 100 },
  colorString:  { min: 1, max: 64 },
} as const

/**
 * Filesystem-path length cap for `importAssets`.
 *
 * POSIX PATH_MAX is typically 4096 on Linux and 1024 on macOS, so 4 KB
 * is a loose-but-finite ceiling that stops a pathological caller from
 * handing us a multi-MB "path" string. The path content is further
 * validated in the MCP server (extension allow-list, realpath resolution,
 * size stat).
 *
 * `paths` count ceiling is conservative (16) to prevent a pathological
 * client from dumping thousands of files into a single call.
 */
export const PATH_LIMITS = {
  pathMax:   { max: 4096 },
  pathsPerCall: { min: 1, max: 16 },
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
const gainDb      = () => num().min(-12).max(12)   // ±12 dB (EQ bands, compressor gain)

/**
 * Apply a `{min, max}` bound (from CLIP_LIMITS / EXPORT_LIMITS) to a coerced
 * number. Collapses the repeated `num().min(X.min).max(X.max)` chain into
 * a single declarative call.
 *
 * Use `rangedInt` for fields that must be whole numbers (pixel dims, fps,
 * millisecond durations); the `.int()` check rejects non-integer coerced
 * inputs before the range check runs.
 */
type Bounds = { min: number; max: number }
const ranged    = (l: Bounds) => num().min(l.min).max(l.max)
const rangedInt = (l: Bounds) => num().int().min(l.min).max(l.max)

/**
 * Export tool input. Every field is optional — callers omit the whole
 * object by sending `{}`. The outer schema is intentionally NOT
 * `.optional()`: MCP tools always receive an object, and leaving the
 * top-level as `ZodObject` keeps the `OperationDef.input` contract
 * uniform (`.shape` is available without an `.unwrap()` dance).
 */
export const exportToBlobInputSchema = z.object({
  width:          rangedInt(EXPORT_LIMITS.width).optional(),
  height:         rangedInt(EXPORT_LIMITS.height).optional(),
  fps:            rangedInt(EXPORT_LIMITS.fps).optional(),
  videoCodec:     videoCodecSchema.optional(),
  videoBitrate:   rangedInt(EXPORT_LIMITS.videoBitrate).optional(),
  loudnessTarget: loudnessTargetSchema.optional(),
  timeoutMs:      rangedInt(EXPORT_LIMITS.timeoutMs).optional(),
})

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
  // `text` has the largest cap — lyrics / quote blocks / lower-thirds
  // can span multiple paragraphs. Still finite to stop a multi-megabyte
  // payload being planted on the timeline.
  text: z.string().max(STRING_LIMITS.textClipText.max).optional(),
  fontFamily: z.string().max(STRING_LIMITS.fontFamily.max).optional(),
  fontSize: ranged(CLIP_LIMITS.textFontSize).optional(),
  // Color strings may be hex / rgba / hsla / named — all short.
  color: z.string().max(STRING_LIMITS.colorString.max).optional(),
  bold: bool().optional(),
  italic: bool().optional(),
  textAlign: textAlignSchema.optional(),
  positionX: num().optional(),
  positionY: num().optional(),
  backgroundColor: z.string().max(STRING_LIMITS.colorString.max).optional(),
  outlineColor: z.string().max(STRING_LIMITS.colorString.max).optional(),
  outlineWidth: ranged(CLIP_LIMITS.textOutline).optional(),
  shadowColor: z.string().max(STRING_LIMITS.colorString.max).optional(),
  shadowBlur: ranged(CLIP_LIMITS.textOutline).optional(),
  shadowOffsetX: ranged(CLIP_LIMITS.textShadowOffsetPx).optional(),
  shadowOffsetY: ranged(CLIP_LIMITS.textShadowOffsetPx).optional(),
  opacity: unipolar100().optional(),
})

// ── Phase 1: project / clip properties ─────────────────────────

export const setProjectNameInputSchema = z.object({
  name: z.string().min(STRING_LIMITS.projectName.min).max(STRING_LIMITS.projectName.max),
})

export const setAspectRatioInputSchema = z.object({
  aspectRatio: aspectRatioSchema,
})

/** Transform fields — positions in px from center, scales in %, crops 0-50%. */
export const updateClipTransformInputSchema = z.object({
  clipId: z.string(),
  positionX: num().optional(),
  positionY: num().optional(),
  rotation: ranged(CLIP_LIMITS.rotationDeg).optional(),
  opacity: unipolar100().optional(),
  scaleX: ranged(CLIP_LIMITS.scalePct).optional(),
  scaleY: ranged(CLIP_LIMITS.scalePct).optional(),
  keepAspectRatio: bool().optional(),
  cropTop:    ranged(CLIP_LIMITS.cropPct).optional(),
  cropBottom: ranged(CLIP_LIMITS.cropPct).optional(),
  cropLeft:   ranged(CLIP_LIMITS.cropPct).optional(),
  cropRight:  ranged(CLIP_LIMITS.cropPct).optional(),
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

/**
 * Unified transition tool.
 *
 * Handles three cases in one schema so we don't burn tool-declaration
 * tokens on three nearly-identical tools:
 *
 *   - `{clipId, type?, durationMs?}`            — set the base transition
 *                                                 (shared by both edges)
 *   - `{clipId, edge, type?, durationMs?}`      — override one edge
 *   - `{clipId, edge, clear: true}`             — remove an edge override
 *                                                 (base re-applies)
 *
 * Validation invariants enforced in the store layer:
 *   - `clear: true` requires `edge` (you can't clear a base that always
 *     applies; remove it by setting `type: 'none'` instead).
 *   - `clear: true` with `type`/`durationMs` is rejected — the two
 *     intents contradict each other and a silent precedence rule would
 *     surprise callers.
 */
export const updateClipTransitionInputSchema = z.object({
  clipId: z.string(),
  edge: transitionEdgeSchema.optional(),
  type: transitionTypeSchema.optional(),
  durationMs: rangedInt(CLIP_LIMITS.transitionDurationMs).optional(),
  clear: z.boolean().optional(),
})

export const updateClipVolumeInputSchema = z.object({
  clipId: z.string(),
  volume: unit(),
})

/** Playback speed + optional ramp (ease-in/out between rangeStart..rangeEnd). */
export const updateClipSpeedInputSchema = z.object({
  clipId: z.string(),
  rate: ranged(CLIP_LIMITS.speedRate).optional(),
  ramp: bool().optional(),
  rampDurationMs: intMs().optional(),
  preservePitch: bool().optional(),
  rangeStart: unit().optional(),
  rangeEnd:   unit().optional(),
})

/**
 * Image-clip top-level fields.
 *
 * Shadow lives in a nested `{enabled,color,blur,offsetX,offsetY}`
 * sub-object on the domain model; updating it requires a per-field
 * merge so the store's shallow `Partial<ImageClip>` can't clobber
 * unspecified fields. That lives in `updateImageClipShadowInputSchema`
 * below — routed through a dedicated tool.
 */
export const updateImageClipInputSchema = z.object({
  clipId: z.string(),
  opacity: unipolar100().optional(),
  blendMode: blendModeSchema.optional(),
  borderRadius: ranged(CLIP_LIMITS.imageBorderRadius).optional(),
})

/**
 * Per-field shadow patch. Flat to dodge the store's shallow-merge
 * footgun (see `updateImageClipInputSchema` doc). Bounds mirror the
 * domain ranges in `src/types/project.ts` on the web side.
 *
 * `color` accepts any string so callers can pass named colors or
 * `rgba(...)` in addition to hex — matches the field's runtime shape
 * in the editor.
 */
export const updateImageClipShadowInputSchema = z.object({
  clipId: z.string(),
  enabled: bool().optional(),
  color:   z.string().max(STRING_LIMITS.colorString.max).optional(),
  blur:    ranged(CLIP_LIMITS.textOutline).optional(),
  offsetX: ranged(CLIP_LIMITS.shadowOffsetPx).optional(),
  offsetY: ranged(CLIP_LIMITS.shadowOffsetPx).optional(),
})

/**
 * Unified video/audio sibling link toggle.
 *
 * `linked: false` unlinks the video/audio pair so they move
 * independently; `linked: true` re-links a previously unlinked pair.
 * Collapses the former `unlinkClip` / `relinkClip` tool pair so the
 * LLM sees one explicit knob instead of two name-only variants.
 */
export const linkClipInputSchema = z.object({
  clipId: z.string(),
  linked: z.boolean(),
})

// ── Phase 2: track move / audio effect ─────────────────────────
// (Per-edge transition set/clear folded into updateClipTransitionInputSchema.)

/** Move a clip to the sibling track of the same type (up = layer above). */
export const moveClipToSiblingTrackInputSchema = z.object({
  clipId: z.string(),
  direction: siblingDirectionSchema,
})

/**
 * AudioEffect (3-band EQ + compressor + noise gate).
 *
 * dB ranges reflect the domain: EQ bands and comp gain are ±12 dB,
 * comp threshold is -50..0 dB, noise gate is -100..0 dB (-100 = off).
 * Comp attack/release are in seconds (0..1).
 */
export const updateClipAudioEffectInputSchema = z.object({
  clipId: z.string(),
  eqLow:         gainDb().optional(),
  eqMid:         gainDb().optional(),
  eqHigh:        gainDb().optional(),
  compressor:    bool().optional(),
  compThreshold: ranged(CLIP_LIMITS.compThresholdDb).optional(),
  compRatio:     ranged(CLIP_LIMITS.compRatio).optional(),
  compAttack:    unit().optional(),
  compRelease:   unit().optional(),
  compGain:      gainDb().optional(),
  noiseGate:     ranged(CLIP_LIMITS.noiseGateDb).optional(),
})

/**
 * `videobuff_import_assets` — import local files into the editor.
 *
 * Paths MUST be absolute filesystem paths readable by the MCP server
 * process. Relative paths are rejected to avoid cwd-dependent behavior
 * across clients. At least one path is required; upper bound is
 * conservative (16) to prevent a pathological client from dumping
 * thousands of files into a single call.
 */
export const importAssetsInputSchema = z.object({
  // Bounds live in PATH_LIMITS so the MCP server and any future CLI
  // callers agree on the same cap without redeclaring the literals.
  paths: z.array(z.string().min(1).max(PATH_LIMITS.pathMax.max))
    .min(PATH_LIMITS.pathsPerCall.min)
    .max(PATH_LIMITS.pathsPerCall.max),
})

export const importAssetsResultSchema = z.object({
  assetIds: z.array(z.string()),
})

/**
 * `videobuff_remove_asset` — delete an asset from the project library.
 *
 * Refuses if any clip still references `assetId` (see bootstrap.ts for
 * the `assetInUse` / `assetNotFound` reasons). `assetId` is a plain
 * string — assets are identified by uuid-v4 in the editor, but we
 * don't constrain the shape here in case the id scheme ever changes.
 */
export const removeAssetInputSchema = z.object({
  assetId: z.string().min(1),
})

/**
 * `videobuff_add_asset_to_timeline` — place an already-imported asset
 * on the timeline as a new clip. Returns `assetNotFound` if `assetId`
 * doesn't resolve in `project.assets`; on success the new clip's id
 * is returned via `addAssetToTimelineResultSchema`.
 *
 * Import of local files is a separate op (`importAssets`) — this one
 * operates strictly on ids already in the library.
 */
export const addAssetToTimelineInputSchema = z.object({
  assetId: z.string().min(1),
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

/**
 * Result shape for mutation tools.
 *
 * Discriminated on `ok` so LLM callers can branch reliably:
 *   - `{ ok: true }`                            — applied
 *   - `{ ok: false, reason: 'clipNotFound' }`   — requested clip id doesn't exist
 *
 * Historically this was `{ ok: true }` only: the web-side store's
 * `mapClipById` helper silently returned tracks unchanged for an unknown
 * id, surfacing as a false success. Making misses explicit lets agents
 * recover (e.g. re-fetch `getProjectInfo` and retry with a fresh id).
 *
 * `reason` is a free-form string so new failure modes can be added
 * without breaking schema compatibility for existing clients.
 */
export const okResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.string() }),
])

/**
 * `selectClip` result — discriminated like `okResultSchema` but the
 * success variant still exposes `selectedClipId` for the caller to
 * confirm what the UI ended up selecting (including `null` on deselect).
 *
 * Failure path: passing a non-null id that doesn't exist on the
 * timeline returns `{ok:false, reason:"clipNotFound"}` — aligned with
 * the mutation tools, so LLM callers can use a single branching
 * pattern across every clip-touching operation.
 */
export const selectClipResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), selectedClipId: z.string().nullable() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
])

/**
 * `addAssetToTimeline` result — discriminated like `okResultSchema` but
 * the success variant surfaces the id of the newly-placed clip so the
 * caller can chain subsequent edits without a `getProjectInfo`
 * round-trip.
 *
 * Failure path: `{ok:false, reason:"assetNotFound"}` when the requested
 * `assetId` isn't in `project.assets`.
 */
export const addAssetToTimelineResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), clipId: z.string().nullable() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
])
