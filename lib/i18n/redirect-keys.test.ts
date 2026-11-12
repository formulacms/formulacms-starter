import { describe, expect, test, vi } from "vitest"
import { ConvexError } from "convex/values"
import {
  buildRedirectKeySet,
  createRedirectKeyCache,
  hasRedirectKey,
  redirectKeyId,
  type RedirectKey,
} from "./redirect-keys"

// Keep in sync with REDIRECT_KEY_CAP in redirect-keys.ts / redirects.ts.
const CAP = 5000

describe("redirectKeyId", () => {
  test("locale-scoped key includes the locale", () => {
    expect(redirectKeyId("fr", "/about")).toBe("fr:/about")
  })

  test("locale-agnostic key uses the * bucket", () => {
    expect(redirectKeyId(undefined, "/about")).toBe("*:/about")
  })
})

describe("hasRedirectKey", () => {
  test("matches a locale-scoped key for the current locale", () => {
    const set = buildRedirectKeySet([{ fromPath: "/old", locale: "fr" }])
    expect(hasRedirectKey(set, "/old", "fr")).toBe(true)
  })

  test("does not match a scoped key under a different locale", () => {
    const set = buildRedirectKeySet([{ fromPath: "/old", locale: "fr" }])
    expect(hasRedirectKey(set, "/old", "en")).toBe(false)
  })

  test("falls back to a locale-agnostic key when scoped is absent", () => {
    const set = buildRedirectKeySet([{ fromPath: "/old" }])
    expect(hasRedirectKey(set, "/old", "fr")).toBe(true)
  })

  test("prefers scoped order but agnostic still matches with no locale", () => {
    const set = buildRedirectKeySet([{ fromPath: "/old" }])
    expect(hasRedirectKey(set, "/old", undefined)).toBe(true)
  })

  test("miss on an unknown path", () => {
    const set = buildRedirectKeySet([{ fromPath: "/old", locale: "fr" }])
    expect(hasRedirectKey(set, "/nope", "fr")).toBe(false)
  })

  test("empty set misses everything", () => {
    const set = buildRedirectKeySet([])
    expect(hasRedirectKey(set, "/anything", "fr")).toBe(false)
    expect(hasRedirectKey(set, "/anything", undefined)).toBe(false)
  })

  test("a scoped locale does not accidentally match an agnostic-only lookup path across locales", () => {
    // fromPath /a is scoped to fr only; en request must miss (fail-fast skip).
    const set = buildRedirectKeySet([{ fromPath: "/a", locale: "fr" }])
    expect(hasRedirectKey(set, "/a", "en")).toBe(false)
    expect(hasRedirectKey(set, "/a", "fr")).toBe(true)
  })
})

describe("createRedirectKeyCache", () => {
  test("returns a set on success and skips misses", async () => {
    const fetcher = vi
      .fn<() => Promise<RedirectKey[]>>()
      .mockResolvedValue([{ fromPath: "/old", locale: "fr" }])
    const getKeySet = createRedirectKeyCache(fetcher, () => 0)

    const set = await getKeySet(1)
    expect(set).not.toBeNull()
    expect(hasRedirectKey(set as Set<string>, "/old", "fr")).toBe(true)
    expect(hasRedirectKey(set as Set<string>, "/other", "fr")).toBe(false)
  })

  test("empty result is a set (skip resolve), not fail-open null", async () => {
    const fetcher = vi.fn<() => Promise<RedirectKey[]>>().mockResolvedValue([])
    const getKeySet = createRedirectKeyCache(fetcher, () => 0)

    const set = await getKeySet(1)
    expect(set).toEqual(new Set())
    expect(set).not.toBeNull()
  })

  test("caches within the TTL window (one fetch)", async () => {
    const fetcher = vi
      .fn<() => Promise<RedirectKey[]>>()
      .mockResolvedValue([{ fromPath: "/old" }])
    let now = 1_000
    const getKeySet = createRedirectKeyCache(fetcher, () => now)

    await getKeySet(1)
    now = 1_000 + 14_999 // still inside 15s TTL
    await getKeySet(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test("refetches after the TTL expires", async () => {
    const fetcher = vi
      .fn<() => Promise<RedirectKey[]>>()
      .mockResolvedValue([{ fromPath: "/old" }])
    let now = 1_000
    const getKeySet = createRedirectKeyCache(fetcher, () => now)

    await getKeySet(1)
    now = 1_000 + 15_001 // past 15s TTL
    await getKeySet(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test("never serves a key set cached under another language version", async () => {
    const fetcher = vi
      .fn<(languageVersion: number) => Promise<RedirectKey[]>>()
      .mockResolvedValueOnce([{ fromPath: "/english-only" }])
      .mockRejectedValueOnce(new Error("convex down"))
    const getKeySet = createRedirectKeyCache(fetcher, () => 1_000)

    expect(await getKeySet(1)).toEqual(new Set(["*:/english-only"]))
    expect(await getKeySet(2)).toBeNull()
    expect(fetcher).toHaveBeenNthCalledWith(1, 1)
    expect(fetcher).toHaveBeenNthCalledWith(2, 2)
  })

  test("rethrows a language-version mismatch instead of failing open", async () => {
    const mismatch = new ConvexError("SITE_LANGUAGE_VERSION_CHANGED")
    const getKeySet = createRedirectKeyCache(
      () => Promise.reject(mismatch),
      () => 0
    )

    await expect(getKeySet(1)).rejects.toBe(mismatch)
  })

  test("fails open (null) when the first fetch throws and there is no stale value", async () => {
    const fetcher = vi
      .fn<() => Promise<RedirectKey[]>>()
      .mockRejectedValue(new Error("convex down"))
    const getKeySet = createRedirectKeyCache(fetcher, () => 0)

    expect(await getKeySet(1)).toBeNull()
  })

  test("serves the stale set when a later fetch throws", async () => {
    const fetcher = vi
      .fn<() => Promise<RedirectKey[]>>()
      .mockResolvedValueOnce([{ fromPath: "/old" }])
      .mockRejectedValueOnce(new Error("convex down"))
    let now = 1_000
    const getKeySet = createRedirectKeyCache(fetcher, () => now)

    const first = await getKeySet(1)
    now = 1_000 + 15_001 // expire so the second call refetches (and throws)
    const second = await getKeySet(1)

    expect(second).toBe(first) // same stale set object
    expect(hasRedirectKey(second as Set<string>, "/old", undefined)).toBe(true)
  })

  test("fails open (null) when the result is capped/possibly truncated", async () => {
    const capped: RedirectKey[] = Array.from({ length: CAP }, (_, i) => ({
      fromPath: `/r${i}`,
    }))
    const fetcher = vi
      .fn<() => Promise<RedirectKey[]>>()
      .mockResolvedValue(capped)
    const getKeySet = createRedirectKeyCache(fetcher, () => 0)

    expect(await getKeySet(1)).toBeNull()
  })
})

// M01c-P3 (recovery design C4, RG8): the key-cache catch is a containing
// boundary, so it signals every failure and keeps its documented fallback.
describe("createRedirectKeyCache containment signal (M01c)", () => {
  function signalsFrom(spy: ReturnType<typeof vi.spyOn>) {
    return spy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes("CMS_MODULE_PARTICIPATION_FAILED")
    )
  }

  test("P3: a throwing fetch with no stale value signals and fails open (null)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const getKeySet = createRedirectKeyCache(
      () => Promise.reject(new Error("CMS_MODULE_STATE_INVALID")),
      () => 0
    )

    expect(await getKeySet(1)).toBeNull()
    expect(signalsFrom(spy)).toEqual([
      [
        "[CMS_MODULE_PARTICIPATION_FAILED] module=redirects boundary=proxy.key-cache",
        {
          code: "CMS_MODULE_PARTICIPATION_FAILED",
          moduleId: "redirects",
          boundary: "proxy.key-cache",
          cause: "CMS_MODULE_STATE_INVALID",
        },
      ],
    ])
    spy.mockRestore()
  })

  test("P3: a throwing refresh signals and serves the stale set", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const fetcher = vi
      .fn<() => Promise<RedirectKey[]>>()
      .mockResolvedValueOnce([{ fromPath: "/old" }])
      .mockRejectedValueOnce(new Error("fetch failed"))
    let now = 1_000
    const getKeySet = createRedirectKeyCache(fetcher, () => now)

    const first = await getKeySet(1)
    expect(signalsFrom(spy)).toEqual([])
    now = 1_000 + 15_001

    expect(await getKeySet(1)).toBe(first)
    expect(signalsFrom(spy)).toHaveLength(1)
    spy.mockRestore()
  })

  test("P3: a disabled module ([] keys) and a capped index are values, not failures", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const empty = createRedirectKeyCache(
      () => Promise.resolve([]),
      () => 0
    )
    const capped = createRedirectKeyCache(
      () =>
        Promise.resolve(
          Array.from({ length: CAP }, (_, i) => ({ fromPath: `/r${i}` }))
        ),
      () => 0
    )

    expect(await empty(1)).toEqual(new Set())
    expect(await capped(1)).toBeNull()
    expect(signalsFrom(spy)).toEqual([])
    spy.mockRestore()
  })
})
