/**
 * Environment defaults and URL helpers for VideoBuff automation.
 * Used by @videobuff/core and @videobuff/mcp.
 */

export const DEFAULT_BASE_URL = 'http://localhost:3000'
export const DEFAULT_LOCALE = 'ja'

export interface Env {
  baseUrl: string
  locale: string
  headless: boolean
}

export function readEnv(): Env {
  return {
    baseUrl: process.env.VIDEOBUFF_URL ?? DEFAULT_BASE_URL,
    locale: process.env.VIDEOBUFF_LOCALE ?? DEFAULT_LOCALE,
    headless: process.env.HEADFUL !== '1',
  }
}

export function editorUrl(baseUrl: string, locale: string): string {
  return `${baseUrl}/${locale}/editor?automation=1`
}
