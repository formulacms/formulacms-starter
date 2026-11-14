import { describe, expect, test, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { issueContactIpProofPairing } from "./contact-ip-proof-pairing"

describe("contact IP proof pairing issuer", () => {
  test("returns a bounded unconfigured result when the Next secret is absent", async () => {
    await expect(
      issueContactIpProofPairing({ secret: "" })
    ).resolves.toEqual({ status: "unconfigured" })
  })

  test("issues only the short-lived proof fields needed by the diagnostic", async () => {
    const result = await issueContactIpProofPairing({
      secret: "next-pairing-secret",
      now: 1_000,
    })

    expect(result).toMatchObject({
      status: "issued",
      proof: {
        expiresAt: 301_000,
        signature: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
    expect(JSON.stringify(result)).not.toContain("next-pairing-secret")
    expect(result.status === "issued" && Object.keys(result.proof).sort()).toEqual(
      ["expiresAt", "signature"]
    )
  })
})
