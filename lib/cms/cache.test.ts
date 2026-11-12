import { ConvexError } from "convex/values"
import { afterEach, describe, expect, test, vi } from "vitest"

const boundary = vi.hoisted(() => ({
  cache: vi.fn((run: () => Promise<unknown>) => run),
}))
vi.mock("next/cache", () => ({ unstable_cache: boundary.cache }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

import { cachedCmsRead, isSiteLanguageVersionChanged } from "./cache"

describe("public language cache boundary", () => {
  test("recognizes native and serialized Convex version mismatches", () => {
    expect(
      isSiteLanguageVersionChanged(
        new ConvexError("SITE_LANGUAGE_VERSION_CHANGED")
      )
    ).toBe(true)
    expect(
      isSiteLanguageVersionChanged(
        new Error("Uncaught ConvexError: SITE_LANGUAGE_VERSION_CHANGED")
      )
    ).toBe(true)
    expect(isSiteLanguageVersionChanged(new Error("Convex unavailable"))).toBe(
      false
    )
  })

  test("rethrows a version mismatch instead of returning the cached-read fallback", async () => {
    const mismatch = new ConvexError("SITE_LANGUAGE_VERSION_CHANGED")

    await expect(
      cachedCmsRead(
        () => Promise.reject(mismatch),
        ["pinned-reader"],
        "fallback",
        []
      )
    ).rejects.toBe(mismatch)
  })

  test("retains the production fallback for an ordinary transient read failure", async () => {
    await expect(
      cachedCmsRead(
        () => Promise.reject(new Error("Convex unavailable")),
        ["ordinary-reader"],
        "fallback",
        []
      )
    ).resolves.toBe("fallback")
  })
})

for (const mode of ["development", "production"] as const) {
  describe(`required CMS reads in ${mode}`, () => {
    async function reader() {
      vi.stubEnv("NODE_ENV", mode)
      vi.resetModules()
      return (await import("./cache")).requiredCmsRead
    }

    test("keeps successful and confirmed-missing values cacheable", async () => {
      const read = await reader()
      await expect(read(async () => "page", ["page"], [])).resolves.toBe("page")
      await expect(read(async () => null, ["missing"], [])).resolves.toBeNull()
      expect(boundary.cache).toHaveBeenCalledTimes(
        mode === "production" ? 2 : 0
      )
      if (mode === "production") {
        expect(boundary.cache).toHaveBeenCalledWith(
          expect.any(Function),
          ["missing"],
          { revalidate: 300, tags: [] }
        )
      }
    })

    test("passes a rejection through the cache boundary and recovers without a fallback value", async () => {
      const read = await reader()
      const failure = new Error("network timeout")
      const run = vi
        .fn<() => Promise<string | null>>()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce("recovered page")
      await expect(read(run, ["page"], [])).rejects.toBe(failure)
      // The production cache receives the original rejecting callback, never
      // one that turns an error into a fulfilled (and cacheable) null.
      if (mode === "production")
        expect(boundary.cache.mock.calls[0][0]).toBe(run)
      await expect(read(run, ["page"], [])).resolves.toBe("recovered page")
      expect(run).toHaveBeenCalledTimes(2)
    })

    test("preserves the language-version coordination error unchanged", async () => {
      const read = await reader()
      const mismatch = new ConvexError("SITE_LANGUAGE_VERSION_CHANGED")
      await expect(
        read(
          async () => {
            throw mismatch
          },
          ["pinned"],
          []
        )
      ).rejects.toBe(mismatch)
    })
  })
}
