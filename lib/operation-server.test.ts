import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  fetchAuthQuery: vi.fn(),
  requireAuth: vi.fn(),
}))

vi.mock("@/lib/auth-server", () => ({
  fetchAuthQuery: mocks.fetchAuthQuery,
  requireAuth: mocks.requireAuth,
}))

import { requireOperationAccess } from "./operation-server"

describe("requireOperationAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireAuth.mockResolvedValue(undefined)
  })

  test("allows the current sanitized operation session", async () => {
    mocks.fetchAuthQuery.mockResolvedValue({
      ownerId: "owner-id",
      authId: "owner-auth-id",
      email: "owner@example.test",
      role: "admin",
    })

    await expect(requireOperationAccess()).resolves.toBeUndefined()
  })

  test("denies a signed-in caller without operation access", async () => {
    mocks.fetchAuthQuery.mockResolvedValue(null)

    await expect(
      requireOperationAccess("Operation access required.")
    ).rejects.toThrow("Operation access required.")
  })

  test("does not query operation access after authentication fails", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Sign in to continue."))

    await expect(requireOperationAccess()).rejects.toThrow(
      "Sign in to continue."
    )
    expect(mocks.fetchAuthQuery).not.toHaveBeenCalled()
  })
})
