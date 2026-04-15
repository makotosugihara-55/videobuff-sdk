/**
 * Persistent Playwright session for driving VideoBuff.
 *
 * One Chromium + one editor tab per process, reused across tool calls.
 * The browser launch cost (~1–2s) is only paid on the first call.
 *
 * Resilient to a bad first attempt: if the dev server was down when the
 * first tool hit, the stale rejected promise is dropped so the next call
 * gets a fresh launch.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { editorUrl, readEnv, type Env } from '@videobuff/contracts'

export interface SessionOptions {
  /** Override environment defaults */
  env?: Partial<Env>
  /** Viewport size (default 1440x900) */
  viewport?: { width: number; height: number }
  /** Timeout for waiting for window.videobuff to be ready (default 20s) */
  readyTimeoutMs?: number
}

export interface Session {
  browser: Browser
  context: BrowserContext
  page: Page
}

/** NEVER write to stdout — it is the JSON-RPC channel. Use stderr. */
export function log(msg: string): void {
  process.stderr.write(`[videobuff] ${msg}\n`)
}

async function launch(opts: SessionOptions = {}): Promise<Session> {
  const env = { ...readEnv(), ...opts.env }
  const viewport = opts.viewport ?? { width: 1440, height: 900 }
  const readyTimeout = opts.readyTimeoutMs ?? 20_000

  let browser: Browser | null = null
  try {
    log(`launching Chromium (headless=${env.headless})`)
    browser = await chromium.launch({ headless: env.headless })
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()
    const url = editorUrl(env.baseUrl, env.locale)
    log(`navigating to ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => window.videobuff?.ready === true,
      null,
      { timeout: readyTimeout },
    )
    log('window.videobuff ready')
    return { browser, context, page }
  } catch (e) {
    if (browser) {
      try { await browser.close() } catch { /* ignore */ }
    }
    throw e
  }
}

/**
 * Manages a single persistent Playwright session.
 *
 * Usage:
 * ```ts
 * const vb = new VideoBuffSession()
 * const { page } = await vb.get()
 * const result = await page.evaluate(() => window.videobuff!.ping())
 * await vb.shutdown()
 * ```
 */
export class VideoBuffSession {
  private sessionPromise: Promise<Session> | null = null
  private opts: SessionOptions

  constructor(opts: SessionOptions = {}) {
    this.opts = opts
  }

  /** Get or create the shared Playwright session. */
  async get(): Promise<Session> {
    if (this.sessionPromise) {
      try {
        return await this.sessionPromise
      } catch (e) {
        log(`previous session failed, retrying: ${String(e)}`)
        this.sessionPromise = null
      }
    }
    const p = launch(this.opts)
    this.sessionPromise = p
    try {
      return await p
    } catch (e) {
      if (this.sessionPromise === p) this.sessionPromise = null
      throw e
    }
  }

  /** Shut down the browser and release resources. */
  async shutdown(): Promise<void> {
    if (!this.sessionPromise) return
    try {
      const s = await this.sessionPromise
      await s.browser.close()
      log('browser closed')
    } catch (e) {
      log(`shutdown error: ${String(e)}`)
    } finally {
      this.sessionPromise = null
    }
  }
}
