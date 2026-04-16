/**
 * Telemetry event schema — shared between the MCP client (producer) and
 * the VideoBuff-Web ingestion endpoint (consumer).
 *
 * Design principles:
 *  - Three events only: session_start, tool_call, session_end.
 *    More granularity can be derived in SQL from these three; adding
 *    events is a breaking change for downstream analytics.
 *  - No user-identifying data. `client_id` is a UUID v4 stored in
 *    `~/.config/videobuff/client_id`, reset by `rm` on the user's side.
 *  - No free-form strings except `tool_name` (already a controlled vocab
 *    declared by the MCP server) and `error_type` (bucketed — see below).
 *  - `duration_bucket` instead of raw ms so we never leak timing data
 *    fine enough to fingerprint a workflow.
 *  - The schema is a discriminated union on `event` so a single POST
 *    batch can carry mixed event types and be validated in one pass.
 *
 * Opt-out: `VIDEOBUFF_TELEMETRY=0` (honored in @videobuff/mcp).
 */

import { z } from 'zod'

/** ISO-3166-ish OS bucket — enough to spot platform-specific bugs. */
export const OsFamilySchema = z.enum(['darwin', 'linux', 'win32', 'other'])
export type OsFamily = z.infer<typeof OsFamilySchema>

/**
 * Duration buckets for tool-call latency.
 *
 * Ranges (inclusive of lower, exclusive of upper):
 *   fast       <   500ms
 *   mid        500ms – 2s
 *   slow       2s    – 10s
 *   very_slow  >=    10s
 *
 * The buckets are coarse on purpose — we care about "is it snappy?" vs
 * "is something pathological?", not p50/p99 to the millisecond.
 */
export const DurationBucketSchema = z.enum(['fast', 'mid', 'slow', 'very_slow'])
export type DurationBucket = z.infer<typeof DurationBucketSchema>

/**
 * Error type bucket — enumerated so the dashboard can group without
 * free-form string joins. `timeout` and `validation` are the two that
 * actually matter; `other` is the escape hatch.
 *
 * If a new category proves common (e.g. `playwright_crash`), extend
 * the enum here in a minor version and teach the MCP client to emit it.
 */
export const ErrorTypeSchema = z.enum([
  'timeout',
  'validation',
  'page_eval',
  'session_lost',
  'other',
])
export type ErrorType = z.infer<typeof ErrorTypeSchema>

/**
 * Convert a raw duration in milliseconds to the bucket used in telemetry.
 * Exported so both the MCP client and any test utility can share the
 * exact cutoff logic.
 */
export function bucketDuration(ms: number): DurationBucket {
  if (ms < 500) return 'fast'
  if (ms < 2_000) return 'mid'
  if (ms < 10_000) return 'slow'
  return 'very_slow'
}

/** Emitted once at MCP server boot, before the first tool call. */
export const SessionStartEventSchema = z.object({
  event: z.literal('session_start'),
  /** Server version, e.g. "0.1.0". Hard-coded in @videobuff/mcp. */
  mcp_version: z.string().min(1).max(32),
  /** Host operating system family, from `os.platform()`. */
  os_family: OsFamilySchema,
})
export type SessionStartEvent = z.infer<typeof SessionStartEventSchema>

/** Emitted after every tool invocation — the workhorse event. */
export const ToolCallEventSchema = z.object({
  event: z.literal('tool_call'),
  /** e.g. "videobuff_add_text_clip". Controlled vocab from the MCP server. */
  tool_name: z.string().min(1).max(64),
  outcome: z.enum(['ok', 'error']),
  duration_bucket: DurationBucketSchema,
  /** Only present when `outcome === 'error'`. */
  error_type: ErrorTypeSchema.optional(),
})
export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>

/** Emitted on graceful shutdown (SIGINT / SIGTERM / beforeExit). */
export const SessionEndEventSchema = z.object({
  event: z.literal('session_end'),
  /** Seconds since session_start. Integer — we don't need sub-second. */
  duration_s: z.number().int().nonnegative(),
  /** Total tool_call events emitted during this session. */
  tool_calls_total: z.number().int().nonnegative(),
})
export type SessionEndEvent = z.infer<typeof SessionEndEventSchema>

/** Discriminated union of all telemetry events. */
export const TelemetryEventSchema = z.discriminatedUnion('event', [
  SessionStartEventSchema,
  ToolCallEventSchema,
  SessionEndEventSchema,
])
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>

/**
 * The POST body for `/api/telemetry/events`.
 *
 * Batched on the client side (flush on buffer full or process exit) to
 * keep request overhead low and simplify rate-limiting on the server.
 */
export const TelemetryBatchSchema = z.object({
  /** UUID v4 persisted on the client. */
  client_id: z.string().uuid(),
  /** Non-empty; upper bound matches the client-side buffer cap. */
  events: z.array(TelemetryEventSchema).min(1).max(100),
  /**
   * Client-side send timestamp (ISO-8601). The server adds its own
   * `received_at`; this one is kept for clock-skew diagnostics only.
   */
  sent_at: z.string().datetime(),
})
export type TelemetryBatch = z.infer<typeof TelemetryBatchSchema>
