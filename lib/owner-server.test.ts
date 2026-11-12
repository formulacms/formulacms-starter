import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  fetchAuthQuery: vi.fn(),
  requireAuth: vi.fn(),
}))

vi.mock("@/lib/auth-server", () => ({
  fetchAuthQuery: mocks.fetchAuthQuery,
  requireAuth: mocks.requireAuth,
}))

import { requireInstallationOwner } from "./owner-server"

describe("requireInstallationOwner", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireAuth.mockResolvedValue(undefined)
  })

  test("allows only a verified sanitized owner session", async () => {
    mocks.fetchAuthQuery.mockResolvedValue({
      ownerId: "owner-id",
      authId: "owner-auth-id",
      email: "owner@example.test",
      role: "admin",
    })

    await expect(requireInstallationOwner()).resolves.toBeUndefined()
    expect(mocks.fetchAuthQuery).toHaveBeenCalledOnce()
  })

  test("denies an unrelated authenticated account whose owner session is null", async () => {
    mocks.fetchAuthQuery.mockResolvedValue(null)

    await expect(
      requireInstallationOwner("Only the installation owner can write source.")
    ).rejects.toThrow("Only the installation owner can write source.")
  })

  test("preserves unauthenticated denial without querying owner state", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Sign in to continue."))

    await expect(requireInstallationOwner()).rejects.toThrow(
      "Sign in to continue."
    )
    expect(mocks.fetchAuthQuery).not.toHaveBeenCalled()
  })
})
