import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  cookieDelete: vi.fn(),
  cookieSet: vi.fn(),
  disable: vi.fn(),
  enable: vi.fn(),
  fetchAuthMutation: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`)
  }),
  safeIsAuthenticated: vi.fn(),
}))

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: mocks.cookieSet, delete: mocks.cookieDelete })),
  draftMode: vi.fn(async () => ({ enable: mocks.enable, disable: mocks.disable })),
}))
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }))
vi.mock("@/lib/auth-server", () => ({
  fetchAuthMutation: mocks.fetchAuthMutation,
  safeIsAuthenticated: mocks.safeIsAuthenticated,
}))

import { GET as enterPreview } from "./route"
import { GET as exitPreview } from "./exit/route"

describe("preview Route Handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.safeIsAuthenticated.mockResolvedValue(true)
    mocks.fetchAuthMutation.mockResolvedValue({
      sessionToken: "opaque-session",
      pageId: "page-1",
      requestedLocale: "fr",
      expiresAt: 2_000_000_000_000,
    })
  })

  test("issues an owner-bound Page+locale session before enabling Draft Mode", async () => {
    await expect(enterPreview(new Request(
      "https://example.test/api/preview?path=%2Ffr%2Fcaf%C3%A9&pageId=page-1&locale=fr"
    ))).rejects.toThrow("redirect:/fr/caf%C3%A9")

    expect(mocks.fetchAuthMutation).toHaveBeenCalledWith(expect.anything(), {
      pageId: "page-1",
      locale: "fr",
    })
    expect(mocks.enable).toHaveBeenCalledOnce()
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      "formulacms-preview-session",
      "opaque-session",
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" })
    )
  })

  test("rejects unbound Draft Mode requests", async () => {
    const response = await enterPreview(new Request(
      "https://example.test/api/preview?path=%2F"
    ))
    expect(response.status).toBe(400)
    expect(mocks.fetchAuthMutation).not.toHaveBeenCalled()
    expect(mocks.enable).not.toHaveBeenCalled()
  })

  test("returns through the session endpoint after authentication", async () => {
    mocks.safeIsAuthenticated.mockResolvedValue(false)
    const request = new Request(
      "https://example.test/api/preview?path=%2Ffr%2Fcaf%C3%A9&pageId=page-1&locale=fr"
    )
    await expect(enterPreview(request)).rejects.toThrow(
      `redirect:/sign-in?next=${encodeURIComponent("/api/preview?path=%2Ffr%2Fcaf%C3%A9&pageId=page-1&locale=fr")}`
    )
    expect(mocks.fetchAuthMutation).not.toHaveBeenCalled()
    expect(mocks.enable).not.toHaveBeenCalled()
  })

  test("exit clears both Draft Mode and the preview-session cookie", async () => {
    await expect(exitPreview(new Request(
      "https://example.test/api/preview/exit?path=%2Ffr%2Fcaf%C3%A9"
    ))).rejects.toThrow("redirect:/fr/caf%C3%A9")
    expect(mocks.disable).toHaveBeenCalledOnce()
    expect(mocks.cookieDelete).toHaveBeenCalledWith("formulacms-preview-session")
  })

  describe.each([
    ["entry", enterPreview, "/api/preview"],
    ["exit", exitPreview, "/api/preview/exit"],
  ] as const)("%s redirect target policy", (_name, handler, endpoint) => {
    // Model only next/navigation's redirect transport. The real exported GET
    // handles the Request, decodes its query and chooses the Location value.
    async function redirectResponse(path: string | null) {
      const url = new URL(endpoint, "https://example.test")
      if (path !== null) url.searchParams.set("path", path)
      url.searchParams.set("pageId", "page-1")
      url.searchParams.set("locale", "fr")
      mocks.redirect.mockImplementationOnce((location: string) => {
        throw new Response(null, { status: 307, headers: { Location: location } })
      })
      try {
        await handler(new Request(url))
      } catch (response) {
        if (response instanceof Response) return response
        throw response
      }
      throw new Error("Expected the handler to redirect")
    }

    test.each([
      ["missing", null],
      ["empty", ""],
      ["slash-backslash", "/\\outside.example/path"],
      ["protocol-relative", "//outside.example/path"],
      ["tab", "/\t/outside.example/path"],
      ["CR", "/\r/outside.example/path"],
      ["LF", "/\n/outside.example/path"],
      ["external absolute", "https://outside.example/path"],
      ["same-origin absolute", "https://example.test/path"],
      ["encoded delimiters", "%2F%5Coutside.example%2Fpath"],
      ["encoded controls", "%2F%09%2Foutside.example%2Fpath"],
      ["dot-normalized authority", "/section/..//outside.example/path"],
      ["unrooted", "fr/page"],
    ])("uses home for %s inputs", async (_label, path) => {
      const response = await redirectResponse(path)
      const location = response.headers.get("Location")
      expect(location).toBe("/")
      expect(new URL(location!, "https://example.test").origin).toBe("https://example.test")
    })

    test.each([
      "/fr/page?tab=draft#heading",
      "/fr/caf%C3%A9",
      "/fr/%2Foutside.example",
    ])("preserves safe relative target %s", async (path) => {
      const response = await redirectResponse(path)
      const location = response.headers.get("Location")
      expect(location).toBe(path)
      expect(new URL(location!, "https://example.test").origin).toBe("https://example.test")
    })
  })
})
