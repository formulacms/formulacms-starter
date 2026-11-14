import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  token: vi.fn<() => Promise<string | null>>(),
  fetchQuery: vi.fn(),
}))

vi.mock("@/lib/auth/convexAuth", () => ({
  convexAuthNextjsAccessToken: mocks.token,
}))
vi.mock("convex/nextjs", () => ({ fetchQuery: mocks.fetchQuery }))

import { getFunctionName } from "convex/server"
import { GET } from "./route"

describe("public header session label route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test("answers null for a signed-out visitor without calling the deployment", async () => {
    mocks.token.mockResolvedValue(null)

    const response = await GET()

    expect(await response.json()).toBeNull()
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(mocks.fetchQuery).not.toHaveBeenCalled()
  })

  test("returns only the display name, with the visitor's own token", async () => {
    mocks.token.mockResolvedValue("access-token")
    mocks.fetchQuery.mockResolvedValue({ name: "Ada" })

    const response = await GET()

    expect(await response.json()).toEqual({ name: "Ada" })
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    const [reference, args, options] = mocks.fetchQuery.mock.calls[0]!
    expect(getFunctionName(reference)).toBe("users:getCurrentUserLabel")
    expect(args).toEqual({})
    expect(options).toEqual({ token: "access-token" })
  })

  test("answers null when the deployment refuses the token", async () => {
    mocks.token.mockResolvedValue("expired-token")
    mocks.fetchQuery.mockRejectedValue(new Error("Unauthenticated"))

    const response = await GET()

    expect(await response.json()).toBeNull()
  })
})
