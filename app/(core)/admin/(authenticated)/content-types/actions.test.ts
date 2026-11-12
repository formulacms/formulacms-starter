import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  assertLocalDevelopment: vi.fn(),
  revalidatePath: vi.fn(),
  requireAuth: vi.fn(),
  requireInstallationOwner: vi.fn(),
  setStarterContentTypeSelection: vi.fn(),
}))

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}))

vi.mock("@/lib/auth-server", () => ({
  fetchAuthMutation: vi.fn(),
  requireAuth: mocks.requireAuth,
}))
vi.mock("@/lib/assert-local-dev", () => ({
  assertLocalDevelopment: mocks.assertLocalDevelopment,
}))
vi.mock("@/lib/owner-server", () => ({
  requireInstallationOwner: mocks.requireInstallationOwner,
}))

vi.mock("@/lib/content-types/starter-curation", () => ({
  setStarterContentTypeSelection: mocks.setStarterContentTypeSelection,
}))

import { setContentTypeStarterAction } from "./actions"

describe("Content Type starter action", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireAuth.mockResolvedValue(undefined)
    mocks.requireInstallationOwner.mockResolvedValue(undefined)
    mocks.setStarterContentTypeSelection.mockResolvedValue(["author"])
  })

  test("denies a non-owner before changing the starter recipe", async () => {
    mocks.requireInstallationOwner.mockRejectedValue(
      new Error(
        "Only the installation owner can curate starter Content Types in the engine."
      )
    )

    await expect(
      setContentTypeStarterAction({ type: "author", inStarter: true })
    ).rejects.toThrow(/installation owner/i)
    expect(mocks.setStarterContentTypeSelection).not.toHaveBeenCalled()
  })

  test("delegates an authorized toggle and revalidates both paths", async () => {
    await expect(
      setContentTypeStarterAction({ type: "author", inStarter: true })
    ).resolves.toEqual(["author"])
    expect(mocks.setStarterContentTypeSelection).toHaveBeenCalledWith({
      type: "author",
      inStarter: true,
    })
    expect(mocks.revalidatePath).toHaveBeenNthCalledWith(
      1,
      "/admin/content-types"
    )
    expect(mocks.revalidatePath).toHaveBeenNthCalledWith(
      2,
      "/admin/content-types/author"
    )
  })

  test("keeps the local-development guard ahead of the source write", async () => {
    mocks.assertLocalDevelopment.mockImplementation(() => {
      throw new Error(
        "Starter Content Type curation is only available in local development."
      )
    })

    await expect(
      setContentTypeStarterAction({ type: "author", inStarter: true })
    ).rejects.toThrow(/local development/i)
    expect(mocks.requireInstallationOwner).not.toHaveBeenCalled()
    expect(mocks.setStarterContentTypeSelection).not.toHaveBeenCalled()
  })
})
