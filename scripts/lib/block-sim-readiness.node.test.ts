import { describe, expect, test } from "vitest"
import {
  BlockSimNotReadyError,
  waitForBlockSimReady,
  type BlockSimProbe,
} from "./block-sim-readiness"

/**
 * A clock that only moves when the waiter sleeps. Tests therefore exercise the
 * real deadline arithmetic without spending real time, and `slept` is the
 * evidence that giving up is bounded rather than merely eventual.
 */
function fakeClock() {
  let current = 0
  const slept: number[] = []
  return {
    slept,
    now: () => current,
    sleep: async (ms: number) => {
      slept.push(ms)
      current += ms
    },
    get total() {
      return slept.reduce((sum, ms) => sum + ms, 0)
    },
  }
}

/** Answers `ok` only from the nth call onward; before that it reports `detail`. */
function readyAfter(calls: number, detail = "HTTP 503"): BlockSimProbe {
  let seen = 0
  return async () => {
    seen += 1
    return seen >= calls ? { ok: true, detail: "HTTP 200" } : { ok: false, detail }
  }
}

describe("waitForBlockSimReady", () => {
  test("polls the exact page a fidelity run photographs", async () => {
    const seen: string[] = []
    const clock = fakeClock()

    const result = await waitForBlockSimReady({
      baseUrl: "http://localhost:3100/",
      type: "newsletter-signup-band",
      probe: async (url) => {
        seen.push(url)
        return { ok: true, detail: "HTTP 200" }
      },
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(seen).toEqual([
      "http://localhost:3100/block-sim/newsletter-signup-band?bare=1",
    ])
    expect(result.url).toBe(
      "http://localhost:3100/block-sim/newsletter-signup-band?bare=1"
    )
  })

  test("returns immediately when the page already answers", async () => {
    const clock = fakeClock()

    const result = await waitForBlockSimReady({
      baseUrl: "http://localhost:3100",
      type: "newsletter-signup-band",
      probe: readyAfter(1),
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(result.attempts).toBe(1)
    expect(clock.slept).toEqual([])
  })

  test("keeps waiting while the site is still starting up", async () => {
    const clock = fakeClock()

    const result = await waitForBlockSimReady({
      baseUrl: "http://localhost:3100",
      type: "newsletter-signup-band",
      probe: readyAfter(3),
      intervalMs: 2_000,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(result.attempts).toBe(3)
    expect(clock.slept).toEqual([2_000, 2_000])
  })

  test("gives up instead of waiting forever when the page never answers", async () => {
    const clock = fakeClock()

    await expect(
      waitForBlockSimReady({
        baseUrl: "http://localhost:3100",
        type: "newsletter-signup-band",
        probe: async () => ({ ok: false, detail: "HTTP 503" }),
        timeoutMs: 10_000,
        intervalMs: 2_000,
        now: clock.now,
        sleep: clock.sleep,
      })
    ).rejects.toBeInstanceOf(BlockSimNotReadyError)

    // Bounded: the waiter never sleeps past the deadline it was given.
    expect(clock.total).toBeLessThanOrEqual(10_000)
    expect(clock.slept.length).toBeGreaterThan(0)
  })

  test("says what the page last answered, so a timeout is diagnosable", async () => {
    const clock = fakeClock()

    const error = await waitForBlockSimReady({
      baseUrl: "http://localhost:3100",
      type: "newsletter-signup-band",
      probe: async () => ({
        ok: false,
        detail: "HTTP 503 — the site is still reconnecting to its backend",
      }),
      timeoutMs: 4_000,
      intervalMs: 2_000,
      now: clock.now,
      sleep: clock.sleep,
    }).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(BlockSimNotReadyError)
    const message = (error as BlockSimNotReadyError).message
    expect(message).toContain(
      "http://localhost:3100/block-sim/newsletter-signup-band?bare=1"
    )
    expect(message).toContain("still reconnecting to its backend")
  })

  test("treats a refused connection as not ready yet, not as a crash", async () => {
    const clock = fakeClock()
    let calls = 0

    const result = await waitForBlockSimReady({
      baseUrl: "http://localhost:3100",
      type: "newsletter-signup-band",
      probe: async () => {
        calls += 1
        if (calls === 1) throw new Error("connect ECONNREFUSED 127.0.0.1:3100")
        return { ok: true, detail: "HTTP 200" }
      },
      intervalMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(result.attempts).toBe(2)
  })

  test("reports a refused connection in the message when it never recovers", async () => {
    const clock = fakeClock()

    const error = await waitForBlockSimReady({
      baseUrl: "http://localhost:3100",
      type: "newsletter-signup-band",
      probe: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:3100")
      },
      timeoutMs: 4_000,
      intervalMs: 2_000,
      now: clock.now,
      sleep: clock.sleep,
    }).catch((thrown: unknown) => thrown)

    expect((error as BlockSimNotReadyError).message).toContain("ECONNREFUSED")
  })

  test("unwraps the reason hidden behind a bare `fetch failed`", async () => {
    const clock = fakeClock()

    const error = await waitForBlockSimReady({
      baseUrl: "http://localhost:3100",
      type: "newsletter-signup-band",
      probe: async () => {
        throw new TypeError("fetch failed", {
          cause: new Error("connect ECONNREFUSED 127.0.0.1:3100"),
        })
      },
      timeoutMs: 4_000,
      intervalMs: 2_000,
      now: clock.now,
      sleep: clock.sleep,
    }).catch((thrown: unknown) => thrown)

    // Without unwrapping, a CI log would say only "fetch failed", which does
    // not distinguish "nothing is listening" from "the request timed out".
    expect((error as BlockSimNotReadyError).message).toContain(
      "fetch failed (connect ECONNREFUSED 127.0.0.1:3100)"
    )
  })

  test("reads the per-address reasons out of a dual-stack connection failure", async () => {
    const clock = fakeClock()

    const error = await waitForBlockSimReady({
      baseUrl: "http://localhost:3100",
      type: "newsletter-signup-band",
      probe: async () => {
        // Exactly the shape Node throws when nothing is listening: the cause is
        // an AggregateError whose own message is empty.
        throw new TypeError("fetch failed", {
          cause: new AggregateError(
            [
              new Error("connect ECONNREFUSED ::1:3100"),
              new Error("connect ECONNREFUSED 127.0.0.1:3100"),
            ],
            ""
          ),
        })
      },
      timeoutMs: 4_000,
      intervalMs: 2_000,
      now: clock.now,
      sleep: clock.sleep,
    }).catch((thrown: unknown) => thrown)

    expect((error as BlockSimNotReadyError).message).toContain(
      "connect ECONNREFUSED 127.0.0.1:3100"
    )
  })
})
