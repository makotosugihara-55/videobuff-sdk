/**
 * Telemetry client for @videobuff/mcp.
 *
 * Emits three events (session_start / tool_call / session_end) to the
 * VideoBuff telemetry endpoint. Fire-and-forget POST, buffered + flushed
 * on thresholds / process exit.
 *
 * ── Privacy model ────────────────────────────────────────────
 *   - Single persistent UUID v4 at `~/.config/videobuff/client_id`.
 *     Delete the file to reset; there's no server-side account.
 *   - No free-form strings, no paths, no file contents, no project data.
 *     Only the schema-declared fields in @videobuff/contracts flow out.
 *   - Opt out entirely with `VIDEOBUFF_TELEMETRY=0`. When opted out,
 *     `track()` is a no-op and no network request is made.
 *
 * ── Failure model ────────────────────────────────────────────
 *   - Every network call has a hard 3s timeout (AbortSignal.timeout).
 *   - Any error is swallowed — telemetry MUST NEVER break the MCP
 *     server. A debug line goes to stderr only when TELEMETRY_DEBUG=1.
 *   - On `beforeExit` we attempt one best-effort flush; we do not
 *     block shutdown waiting for it.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  type OsFamily,
  type TelemetryBatch,
  type TelemetryEvent,
  bucketDuration,
} from '@videobuff/contracts'

// ── Config ───────────────────────────────────────────────────

/**
 * Default endpoint. Override with VIDEOBUFF_TELEMETRY_URL for
 * self-hosted forks / local dev.
 */
const DEFAULT_ENDPOINT = 'https://videobuff.com/api/telemetry/events'

/** Flush when buffer hits this many events (or on exit). */
const BUFFER_FLUSH_THRESHOLD = 20

/** Upper bound on buffered events to guard against runaway emitters. */
const BUFFER_HARD_CAP = 100

/** Network timeout for the POST. Telemetry must never wedge the server. */
const POST_TIMEOUT_MS = 3_000

/** client_id file location — XDG-ish, same on all OSes for simplicity. */
const CLIENT_ID_PATH = join(homedir(), '.config', 'videobuff', 'client_id')

// ── Types ────────────────────────────────────────────────────

interface Telemetry {
  /**
   * Queue an event. Safe to call even when disabled — it becomes a no-op.
   * Never throws; errors go to debug log.
   */
  track(event: TelemetryEvent): void
  /**
   * Best-effort synchronous-ish flush. Returns the in-flight promise
   * so callers that want to await can (exit handlers generally don't).
   */
  flush(): Promise<void>
  /** Total tool_call events emitted since init — for session_end payload. */
  readonly toolCallsTotal: number
  /** Whether telemetry is enabled. */
  readonly enabled: boolean
}

// ── Singleton state ──────────────────────────────────────────

let instance: Telemetry | null = null

// ── Helpers ──────────────────────────────────────────────────

function debug(msg: string): void {
  if (process.env.TELEMETRY_DEBUG === '1') {
    process.stderr.write(`[telemetry] ${msg}\n`)
  }
}

function detectOsFamily(): OsFamily {
  const p = platform()
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p
  return 'other'
}

/**
 * UUID v4 pattern. We don't validate strict variant bits because the
 * file is under the user's control — if they corrupt it we just rotate.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Load `~/.config/videobuff/client_id`, creating it (with a fresh UUID)
 * on first run. Any I/O or parse error falls back to an in-memory UUID
 * so telemetry still works on read-only filesystems, at the cost of a
 * "new user" per session in that case.
 */
async function loadOrCreateClientId(): Promise<string> {
  try {
    const raw = (await readFile(CLIENT_ID_PATH, 'utf8')).trim()
    if (UUID_RE.test(raw)) return raw
    debug(`client_id file malformed, regenerating: ${CLIENT_ID_PATH}`)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      debug(`client_id read failed (${code}), will try to (re)create`)
    }
  }
  const id = randomUUID()
  try {
    await mkdir(dirname(CLIENT_ID_PATH), { recursive: true, mode: 0o700 })
    await writeFile(CLIENT_ID_PATH, id + '\n', { mode: 0o600 })
  } catch (e) {
    debug(`client_id write failed (${(e as Error).message}), using ephemeral id`)
  }
  return id
}

// ── No-op implementation (opt-out path) ──────────────────────

const noopTelemetry: Telemetry = {
  track: () => {},
  flush: async () => {},
  toolCallsTotal: 0,
  enabled: false,
}

// ── Real implementation ──────────────────────────────────────

function createTelemetry(clientId: string, endpoint: string): Telemetry {
  const buffer: TelemetryEvent[] = []
  let toolCallsTotal = 0
  let inFlight: Promise<void> | null = null

  async function postBatch(events: TelemetryEvent[]): Promise<void> {
    const batch: TelemetryBatch = {
      client_id: clientId,
      events,
      sent_at: new Date().toISOString(),
    }
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      })
      if (!res.ok) {
        debug(`POST ${endpoint} → ${res.status}`)
      }
    } catch (e) {
      debug(`POST failed: ${(e as Error).message}`)
    }
  }

  function flush(): Promise<void> {
    if (buffer.length === 0) return inFlight ?? Promise.resolve()
    const toSend = buffer.splice(0, buffer.length)
    // Chain onto any in-flight request to preserve ordering. Failures
    // are swallowed inside postBatch, so the chain never rejects.
    inFlight = (inFlight ?? Promise.resolve()).then(() => postBatch(toSend))
    return inFlight
  }

  function track(event: TelemetryEvent): void {
    if (event.event === 'tool_call') toolCallsTotal += 1
    if (buffer.length >= BUFFER_HARD_CAP) {
      // Drop oldest rather than overflow memory. Unlikely in practice.
      buffer.shift()
    }
    buffer.push(event)
    if (buffer.length >= BUFFER_FLUSH_THRESHOLD) {
      // Fire-and-forget.
      void flush()
    }
  }

  return {
    track,
    flush,
    get toolCallsTotal() { return toolCallsTotal },
    enabled: true,
  }
}

// ── Public API ───────────────────────────────────────────────

export interface InitTelemetryOptions {
  /** MCP server version — included in session_start. */
  mcpVersion: string
}

/**
 * Initialize the telemetry singleton.
 *
 * - Honors `VIDEOBUFF_TELEMETRY=0` (no-op mode).
 * - Emits `session_start` immediately.
 * - Registers a `beforeExit` hook that emits `session_end` and flushes.
 *
 * Returns a handle callers can use to emit `tool_call` events and to
 * query `enabled` / `toolCallsTotal` if needed.
 */
export async function initTelemetry(opts: InitTelemetryOptions): Promise<Telemetry> {
  if (instance) return instance

  if (process.env.VIDEOBUFF_TELEMETRY === '0') {
    debug('disabled via VIDEOBUFF_TELEMETRY=0')
    instance = noopTelemetry
    return instance
  }

  const endpoint = process.env.VIDEOBUFF_TELEMETRY_URL ?? DEFAULT_ENDPOINT
  const clientId = await loadOrCreateClientId()
  const t = createTelemetry(clientId, endpoint)

  const sessionStartedAt = Date.now()
  t.track({
    event: 'session_start',
    mcp_version: opts.mcpVersion,
    os_family: detectOsFamily(),
  })

  // Best-effort flush on graceful exit. `beforeExit` fires when the
  // event loop has nothing left to do, which is the right moment to
  // piggyback a final POST. On SIGINT/SIGTERM the caller's own signal
  // handler decides whether to await this.
  let endEmitted = false
  const emitEnd = (): Promise<void> => {
    if (endEmitted) return Promise.resolve()
    endEmitted = true
    const durationS = Math.max(0, Math.floor((Date.now() - sessionStartedAt) / 1000))
    t.track({
      event: 'session_end',
      duration_s: durationS,
      tool_calls_total: t.toolCallsTotal,
    })
    return t.flush()
  }
  process.on('beforeExit', () => { void emitEnd() })

  // Expose the end emitter so signal handlers in index.ts can await it.
  // Attaching to the instance keeps the public surface typed; casting
  // once is cleaner than adding an optional method to the interface.
  ;(t as Telemetry & { emitEnd: () => Promise<void> }).emitEnd = emitEnd

  instance = t
  return t
}

/**
 * Accessor for code paths that don't want to await init (e.g. tool
 * handlers). Returns the no-op telemetry before init completes, which
 * is fine — a couple of tool calls at startup just don't get tracked.
 */
export function getTelemetry(): Telemetry {
  return instance ?? noopTelemetry
}

/**
 * Emit a tool_call event. Thin convenience wrapper that also handles
 * the outcome/duration/error bucketing so callers don't need to import
 * the schema helpers at every call site.
 */
export function trackToolCall(
  toolName: string,
  outcome: 'ok' | 'error',
  durationMs: number,
  errorType?:
    | 'timeout'
    | 'validation'
    | 'page_eval'
    | 'session_lost'
    | 'other',
): void {
  const t = getTelemetry()
  if (!t.enabled) return
  t.track({
    event: 'tool_call',
    tool_name: toolName,
    outcome,
    duration_bucket: bucketDuration(durationMs),
    ...(outcome === 'error' && errorType ? { error_type: errorType } : {}),
  })
}

/**
 * Force-flush + emit session_end. Call from signal handlers in the MCP
 * server's lifecycle block. Safe to call multiple times (idempotent).
 * Falls through silently when telemetry is disabled or uninitialized.
 */
export async function shutdownTelemetry(): Promise<void> {
  const t = instance
  if (!t || !t.enabled) return
  const withEnd = t as Telemetry & { emitEnd?: () => Promise<void> }
  if (withEnd.emitEnd) await withEnd.emitEnd()
  await t.flush()
}
