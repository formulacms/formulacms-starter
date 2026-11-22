/**
 * Wait until the block simulator can actually answer, before a fidelity run
 * photographs it or the click check opens it (block-fidelity plan §5 D1,
 * rules 3–4).
 *
 * "The port is open" is the wrong question. The simulator page needs two things
 * running, not one: the site, and the content backend behind it. With the
 * backend missing the site still answers the socket — with HTTP 503, "formulacms
 * is reconnecting" — and a capture run started at that moment photographs an
 * error page. So this polls the exact page the run will photograph and insists
 * on a successful answer.
 *
 * The clock and the probe are injected because the property worth proving is
 * that giving up is *bounded*: the waiter must fail loudly rather than hang a
 * CI job until the job timeout kills it.
 */
/** The bare simulator page of one block type. */
export function blockSimulatorUrl(baseUrl: string, type: string): string {
  return `${baseUrl.replace(/\/$/, "")}/block-sim/${type}?bare=1`
}

/** Long enough for a cold dev server to compile the page on a CI runner. */
export const DEFAULT_READY_TIMEOUT_MS = 300_000
export const DEFAULT_READY_INTERVAL_MS = 2_000
const PROBE_TIMEOUT_MS = 15_000

export type BlockSimProbeResult = {
  ok: boolean
  /** What the page answered, in words a reader can act on. */
  detail: string
}

export type BlockSimProbe = (url: string) => Promise<BlockSimProbeResult>

export class BlockSimNotReadyError extends Error {
  readonly url: string
  readonly attempts: number

  constructor({
    url,
    attempts,
    waitedMs,
    lastDetail,
  }: {
    url: string
    attempts: number
    waitedMs: number
    lastDetail: string
  }) {
    super(
      [
        `The block preview page never became ready, so there was nothing to check.`,
        `Waited ${Math.round(waitedMs / 1000)} seconds and tried ${attempts} time(s): ${url}`,
        `The last try answered: ${lastDetail}`,
        `The preview page needs both the site and its content backend running. Start them together, then try again.`,
      ].join("\n")
    )
    this.name = "BlockSimNotReadyError"
    this.url = url
    this.attempts = attempts
  }
}

async function fetchProbe(url: string): Promise<BlockSimProbeResult> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    redirect: "manual",
  })
  if (response.ok) return { ok: true, detail: `HTTP ${response.status}` }
  return {
    ok: false,
    detail:
      response.status === 503
        ? "HTTP 503 — the site is still reconnecting to its backend"
        : `HTTP ${response.status}`,
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * `fetch` reports a refused connection as a bare "fetch failed" and hides the
 * reason on `cause`. The reason is the whole diagnostic value, so unwrap it.
 * Node wraps a dual-stack connection failure in an `AggregateError` whose own
 * message is empty and whose per-address errors carry the text, so read those
 * too rather than reporting nothing.
 */
function reasonFor(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined
  if (cause.message) return cause.message
  if (cause instanceof AggregateError) {
    const reasons = [
      ...new Set(
        cause.errors
          .map((inner: unknown) =>
            inner instanceof Error ? inner.message : String(inner)
          )
          .filter(Boolean)
      ),
    ]
    if (reasons.length > 0) return reasons.join("; ")
  }
  const code = (cause as NodeJS.ErrnoException).code
  return code || undefined
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const reason = reasonFor(error.cause)
  return reason ? `${error.message} (${reason})` : error.message
}

export type WaitForBlockSimReadyInput = {
  baseUrl: string
  type: string
  timeoutMs?: number
  intervalMs?: number
  probe?: BlockSimProbe
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (message: string) => void
}

export async function waitForBlockSimReady({
  baseUrl,
  type,
  timeoutMs = DEFAULT_READY_TIMEOUT_MS,
  intervalMs = DEFAULT_READY_INTERVAL_MS,
  probe = fetchProbe,
  sleep = defaultSleep,
  now = () => Date.now(),
  log,
}: WaitForBlockSimReadyInput): Promise<{ url: string; attempts: number }> {
  const url = blockSimulatorUrl(baseUrl, type)
  const startedAt = now()
  let attempts = 0
  let lastDetail = "nothing — the page was never reached"

  for (;;) {
    attempts += 1
    // A server that is not listening yet rejects the connection outright. That
    // is the ordinary early state, not an error worth ending the wait over.
    const result = await probe(url).then(
      (value) => value,
      (error: unknown) => ({ ok: false, detail: describeError(error) })
    )
    if (result.ok) {
      log?.(`The block preview page answered after ${attempts} try(s): ${url}`)
      return { url, attempts }
    }
    lastDetail = result.detail

    const waitedMs = now() - startedAt
    // Stop as soon as another wait would carry us past the deadline, so the
    // total time spent waiting never exceeds what the caller allowed.
    if (waitedMs + intervalMs > timeoutMs) {
      throw new BlockSimNotReadyError({ url, attempts, waitedMs, lastDetail })
    }
    await sleep(intervalMs)
  }
}
