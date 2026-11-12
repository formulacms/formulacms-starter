import { afterEach, describe, expect, test, vi } from "vitest"
import {
  AUTH_IP_EXPIRES_HEADER,
  AUTH_IP_HASH_HEADER,
  AUTH_IP_SIGNATURE_HEADER,
  AUTH_NEXT_ORIGIN,
  AUTH_ORIGIN_HEADER,
  verifyAuthIpProof,
} from "@/convex/lib/authIpProof"
import { OWNER_CLAIM_HEADER } from "@/convex/lib/ownerClaim"
import { addNextAuthClientProof } from "./next-auth-client-proof"

describe("Next auth client proof", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test("replaces caller-supplied proof headers with a signed server proof", async () => {
    const secret = "next-auth-proof-test-secret"
    const request = new Request(
      "https://cms.example.com/api/auth/sign-up/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.30",
          [OWNER_CLAIM_HEADER]: "one-time-owner-code",
          [AUTH_ORIGIN_HEADER]: AUTH_NEXT_ORIGIN,
          [AUTH_IP_HASH_HEADER]: "a".repeat(64),
          [AUTH_IP_EXPIRES_HEADER]: String(Date.now() + 60_000),
          [AUTH_IP_SIGNATURE_HEADER]: "b".repeat(64),
        },
        body: "{}",
      }
    )

    const forwarded = await addNextAuthClientProof(request, { secret })
    const verifiedIpHash = await verifyAuthIpProof(
      {
        ipHash: forwarded.headers.get(AUTH_IP_HASH_HEADER) ?? undefined,
        expiresAt: Number(forwarded.headers.get(AUTH_IP_EXPIRES_HEADER)),
        signature: forwarded.headers.get(AUTH_IP_SIGNATURE_HEADER) ?? undefined,
      },
      { secret }
    )

    expect(forwarded.headers.get(AUTH_ORIGIN_HEADER)).toBe(AUTH_NEXT_ORIGIN)
    expect(forwarded.headers.get(OWNER_CLAIM_HEADER)).toBe(
      "one-time-owner-code"
    )
    expect(verifiedIpHash).toMatch(/^[a-f0-9]{64}$/)
    expect(verifiedIpHash).not.toBe("a".repeat(64))
    expect(await forwarded.text()).toBe("{}")
  })

  test("uses one loopback bucket for local development without proxy headers", async () => {
    vi.stubEnv("NODE_ENV", "development")
    const request = new Request(
      "http://localhost:3000/api/auth/sign-up/email",
      { method: "POST", body: "{}" }
    )

    const forwarded = await addNextAuthClientProof(request, {
      secret: "next-auth-proof-test-secret",
    })

    const verifiedIpHash = await verifyAuthIpProof(
      {
        ipHash: forwarded.headers.get(AUTH_IP_HASH_HEADER) ?? undefined,
        expiresAt: Number(forwarded.headers.get(AUTH_IP_EXPIRES_HEADER)),
        signature: forwarded.headers.get(AUTH_IP_SIGNATURE_HEADER) ?? undefined,
      },
      { secret: "next-auth-proof-test-secret" }
    )

    expect(verifiedIpHash).toMatch(/^[a-f0-9]{64}$/)
  })

  test("does not mint a shared proof in production without proxy headers", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const request = new Request(
      "https://cms.example.com/api/auth/sign-up/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [AUTH_IP_HASH_HEADER]: "a".repeat(64),
          [AUTH_IP_EXPIRES_HEADER]: String(Date.now() + 60_000),
          [AUTH_IP_SIGNATURE_HEADER]: "b".repeat(64),
        },
        body: "{}",
      }
    )

    const forwarded = await addNextAuthClientProof(request, {
      secret: "next-auth-proof-test-secret",
    })

    expect(forwarded.headers.get(AUTH_ORIGIN_HEADER)).toBe(AUTH_NEXT_ORIGIN)
    expect(forwarded.headers.get(AUTH_IP_HASH_HEADER)).toBeNull()
    expect(forwarded.headers.get(AUTH_IP_EXPIRES_HEADER)).toBeNull()
    expect(forwarded.headers.get(AUTH_IP_SIGNATURE_HEADER)).toBeNull()
    expect(await forwarded.text()).toBe("{}")
  })
})
