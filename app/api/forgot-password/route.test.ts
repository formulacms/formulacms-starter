import { afterEach, describe, expect, test, vi } from "vitest"
import {
  hashAuthClientIdentity,
  verifyAuthIpProof,
} from "@/convex/lib/authIpProof"

const { fetchAction } = vi.hoisted(() => ({
  fetchAction: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock("convex/nextjs", () => ({ fetchAction }))

import { POST } from "./route"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe("POST /api/forgot-password", () => {
  test("mints a signed proof for the client identity observed by Next", async () => {
    const secret = "forgot-password-proof-secret"
    vi.stubEnv("CONTACT_IP_PROOF_SECRET", secret)

    const response = await POST(
      new Request("https://formulacms.test/api/forgot-password", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.41, 198.51.100.9",
        },
        body: JSON.stringify({ email: " Owner@Example.com " }),
      })
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(fetchAction).toHaveBeenCalledOnce()

    const args = fetchAction.mock.calls[0]?.[1]
    expect(args).toMatchObject({
      email: " Owner@Example.com ",
      redirectTo: "/reset-password",
      ipHash: await hashAuthClientIdentity("203.0.113.41"),
      ipHashExpiresAt: expect.any(Number),
      ipHashSignature: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    await expect(
      verifyAuthIpProof(
        {
          ipHash: args?.ipHash,
          expiresAt: args?.ipHashExpiresAt,
          signature: args?.ipHashSignature,
        },
        { secret }
      )
    ).resolves.toBe(args?.ipHash)
  })

  test("omits proof fields when the shared secret is not configured", async () => {
    vi.stubEnv("CONTACT_IP_PROOF_SECRET", "")

    const response = await POST(
      new Request("https://formulacms.test/api/forgot-password", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.41",
        },
        body: JSON.stringify({ email: "owner@example.com" }),
      })
    )

    expect(response.status).toBe(200)
    expect(fetchAction).toHaveBeenCalledOnce()
    expect(fetchAction.mock.calls[0]?.[1]).toEqual({
      email: "owner@example.com",
      redirectTo: "/reset-password",
    })
  })
})
