/**
 * Shared types for the VideoBuff automation API.
 * Derived from the Zod schemas in schemas.ts — single source of truth.
 */

import { z } from 'zod'
import {
  videoCodecSchema,
  loudnessTargetSchema,
  exportSettingsSchema,
} from './schemas.js'

/** Video codec for export. */
export type VideoCodecType = z.infer<typeof videoCodecSchema>

/**
 * Integrated loudness (LUFS) normalization target.
 * - 'off'          : no normalization
 * - 'webSns'       : -14 LUFS (YouTube / Spotify / TikTok / Instagram)
 * - 'applePodcast' : -16 LUFS (Apple Music / Apple Podcasts)
 * - 'broadcast'    : -23 LUFS (EBU R128 / ATSC A/85)
 */
export type LoudnessTargetKey = z.infer<typeof loudnessTargetSchema>

/** Resolved export settings returned after an export completes. */
export type ExportSettings = z.infer<typeof exportSettingsSchema>

/**
 * Export phase — used by the web app for progress reporting.
 * Not backed by a Zod schema because it flows client-side only.
 */
export type ExportPhase = 'idle' | 'rendering' | 'muxing' | 'done' | 'error'
