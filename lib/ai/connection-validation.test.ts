import { describe, expect, test, vi } from "vitest"
import {
  validateApiConnection,
  type FetchLike,
} from "./connection-validation"

describe("validateApiConnection", () => {
  test("fails closed when the key is absent", async () => {
    const fetch = vi.fn()
    await expect(
      validateApiConnection("openrouter", "  ", { fetch })
    ).resolves.toEqual({ state: "not-configured", issue: "missing-key" })
    expect(fetch).not.toHaveBeenCalled()
  })

  test.each([
    ["openrouter", "https://openrouter.ai/api/v1/key", "authorization"],
    ["anthropic", "https://api.anthropic.com/v1/models?limit=1", "x-api-key"],
    ["openai", "https://api.openai.com/v1/models", "authorization"],
  ] as const)(
    "authenticates %s without generation",
    async (provider, url, header) => {
      const fetch = vi.fn<FetchLike>(async () =>
        provider === "openrouter"
          ? Response.json({ data: { limit_remaining: 10 } })
          : Response.json({ data: [] })
      )

      await expect(
        validateApiConnection(provider, "secret-sentinel", { fetch })
      ).resolves.toEqual({ state: "authenticated", method: "api-key" })

      expect(fetch).toHaveBeenCalledOnce()
      const [calledUrl, init] = fetch.mock.calls[0]!
      expect(calledUrl).toBe(url)
      expect(
        Object.keys(init?.headers ?? {}).map((name) => name.toLowerCase())
      ).toContain(header)
      expect(JSON.stringify(init)).not.toContain("prompt")
    }
  )

  test.each([401, 403])(
    "normalizes rejected credentials (%s)",
    async (status) => {
      const fetch = vi.fn(async () => new Response(null, { status }))
      await expect(
        validateApiConnection("openai", "bad-key", { fetch })
      ).resolves.toEqual({ state: "invalid", issue: "credentials-rejected" })
    }
  )

  test("rejects an OpenRouter management key for generation", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ data: { is_management_key: true } })
    )
    await expect(
      validateApiConnection("openrouter", "management-key", { fetch })
    ).resolves.toEqual({ state: "invalid", issue: "wrong-key-type" })
  })

  test("surfaces an exhausted OpenRouter key", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ data: { limit_remaining: 0 } })
    )
    await expect(
      validateApiConnection("openrouter", "exhausted-key", { fetch })
    ).resolves.toEqual({ state: "invalid", issue: "quota-exhausted" })
  })

  test("normalizes rate limits and provider failures", async () => {
    const rateLimited = vi.fn(async () => new Response(null, { status: 429 }))
    await expect(
      validateApiConnection("anthropic", "key", { fetch: rateLimited })
    ).resolves.toEqual({ state: "unreachable", issue: "rate-limited" })

    const failed = vi.fn(async () => new Response(null, { status: 503 }))
    await expect(
      validateApiConnection("anthropic", "key", { fetch: failed })
    ).resolves.toEqual({ state: "unreachable", issue: "service-error" })
  })

  test("normalizes network failures without leaking vendor text", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("secret vendor diagnostic")
    })
    const result = await validateApiConnection("openai", "secret", { fetch })
    expect(result).toEqual({ state: "unreachable", issue: "network" })
    expect(JSON.stringify(result)).not.toContain("secret vendor diagnostic")
  })
})
