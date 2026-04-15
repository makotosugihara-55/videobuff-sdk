/**
 * Shared types for the VideoBuff automation API.
 * These mirror the web app's internal types but are decoupled —
 * the web app will import from here (not the other way around).
 */

/** Video codec for export. */
export type VideoCodecType = 'h264' | 'h265'

/**
 * Integrated loudness (LUFS) normalization target.
 * - 'off'          : no normalization
 * - 'webSns'       : -14 LUFS (YouTube / Spotify / TikTok / Instagram)
 * - 'applePodcast' : -16 LUFS (Apple Music / Apple Podcasts)
 * - 'broadcast'    : -23 LUFS (EBU R128 / ATSC A/85)
 */
export type LoudnessTargetKey = 'off' | 'webSns' | 'applePodcast' | 'broadcast'

/** Resolved export settings returned after an export completes. */
export interface ExportSettings {
  width: number
  height: number
  fps: number
  videoCodec: VideoCodecType
  videoBitrate: number
  audioBitrate: number
  audioSampleRate: number
  loudnessTarget: LoudnessTargetKey
  previewFrameWidth: number
  previewFrameHeight: number
}

/** Any JSON-serializable value. Used for snapshot return types. */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json }
