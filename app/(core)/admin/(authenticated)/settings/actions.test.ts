// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  issueContactIpProofPairing: vi.fn(),
  requireAuth: vi.fn(),
  requireInstallationOwner: vi.fn(),
}))

vi.mock("server-only", () => ({}))

vi.mock("@/lib/auth-server", () => ({
  requireAuth: mocks.requireAuth,
}))
vi.mock("@/lib/owner-server", () => ({
  requireInstallationOwner: mocks.requireInstallationOwner,
}))

vi.mock("@/lib/auth/contact-ip-proof-pairing", () => ({
  issueContactIpProofPairing: mocks.issueContactIpProofPairing,
}))

import { issueContactIpProofPairingForSettings } from "./actions"

describe("issueContactIpProofPairingForSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireAuth.mockResolvedValue(undefined)
    mocks.requireInstallationOwner.mockResolvedValue(undefined)
  })

  test("requires authentication and durable-owner access before issuing a minimal proof result", async () => {
    const issued = {
      status: "issued" as const,
      proof: { expiresAt: 1_000, signature: "a".repeat(64) },
    }
    mocks.issueContactIpProofPairing.mockResolvedValue(issued)

    await expect(issueContactIpProofPairingForSettings()).resolves.toEqual(
      issued
    )

    expect(mocks.requireAuth).toHaveBeenCalledWith(
      "Sign in to run diagnostics."
    )
    expect(mocks.requireInstallationOwner).toHaveBeenCalledWith(
      "You don't have permission to run diagnostics."
    )
    expect(mocks.issueContactIpProofPairing).toHaveBeenCalledOnce()
  })

  test("does not issue a proof without the installation owner", async () => {
    mocks.requireInstallationOwner.mockRejectedValue(
      new Error("You don't have permission to run diagnostics.")
    )

    await expect(issueContactIpProofPairingForSettings()).rejects.toThrow(
      "You don't have permission to run diagnostics."
    )

    expect(mocks.issueContactIpProofPairing).not.toHaveBeenCalled()
  })

  test("does not resolve owner access or issue a proof when authentication fails", async () => {
    mocks.requireAuth.mockRejectedValue(
      new Error("Sign in to run diagnostics.")
    )

    await expect(issueContactIpProofPairingForSettings()).rejects.toThrow(
      "Sign in to run diagnostics."
    )

    expect(mocks.requireInstallationOwner).not.toHaveBeenCalled()
    expect(mocks.issueContactIpProofPairing).not.toHaveBeenCalled()
  })

  test("returns the issuer's bounded unconfigured shape unchanged", async () => {
    mocks.issueContactIpProofPairing.mockResolvedValue({
      status: "unconfigured",
    })

    await expect(issueContactIpProofPairingForSettings()).resolves.toEqual({
      status: "unconfigured",
    })
  })
})
