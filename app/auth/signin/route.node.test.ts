import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"

// The real Convex Auth sign-in route with the app's allowlist; only the
// deployment transport (`fetch`) is replaced.
const CONVEX_URL = "https://allowlist-fixture.convex.cloud"
let POST: (request: Request) => Promise<Response>

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", CONVEX_URL)
  POST = (await import("./route")).POST
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function signInCall(path: string, origin = "http://localhost:3000") {
  return new Request("http://localhost:3000/auth/signin?path=/api/mutation", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "localhost:3000",
      origin,
    },
    body: JSON.stringify({
      path,
      format: "convex_encoded_json",
      args: [{ username: "owner", password: "password123" }],
    }),
  })
}

describe("sign-in route allowlist (ADR-0056)", () => {
  test("forwards the username-and-password sign-in to the deployment", async () => {
    const upstream = vi.fn(async () =>
      Response.json({
        status: "success",
        value: { status: "error", userError: { error: "INVALID_CREDENTIALS" } },
      })
    )
    vi.stubGlobal("fetch", upstream)

    const response = await POST(signInCall("auth:signInWithUsernamePassword"))

    expect(response.status).toBe(200)
    expect(upstream).toHaveBeenCalledOnce()
    expect(upstream).toHaveBeenCalledWith(
      `${CONVEX_URL}/api/mutation`,
      expect.objectContaining({ method: "POST" })
    )
  })

  test.each([
    "auth:signUpWithUsernamePassword",
    "auth:changePassword",
    "auth:signOut",
    "auth:refreshSession",
    "cms/owner:createOwnerAccount",
  ])("refuses %s without calling the deployment", async (path) => {
    const upstream = vi.fn()
    vi.stubGlobal("fetch", upstream)

    const response = await POST(signInCall(path))

    expect(response.status).toBe(403)
    expect(await response.text()).toBe(
      `${path} is not exposed through the auth proxy.`
    )
    expect(upstream).not.toHaveBeenCalled()
  })

  test("refuses a cross-site sign-in before reading the call", async () => {
    const upstream = vi.fn()
    vi.stubGlobal("fetch", upstream)

    const response = await POST(
      signInCall("auth:signInWithUsernamePassword", "https://evil.example")
    )

    expect(response.status).toBe(403)
    expect(upstream).not.toHaveBeenCalled()
  })
})
