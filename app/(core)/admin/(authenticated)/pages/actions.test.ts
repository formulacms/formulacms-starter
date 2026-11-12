// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  fetchQuery: vi.fn(),
  requireAuth: vi.fn(),
  requireOperationAccess: vi.fn(),
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}))

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
  revalidateTag: mocks.revalidateTag,
}))
vi.mock("convex/nextjs", () => ({ fetchQuery: mocks.fetchQuery }))
vi.mock("@/lib/auth-server", () => ({ requireAuth: mocks.requireAuth }))
vi.mock("@/lib/operation-server", () => ({
  requireOperationAccess: mocks.requireOperationAccess,
}))

import { revalidatePagePaths } from "./actions"

describe("revalidatePagePaths", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireAuth.mockResolvedValue(undefined)
    mocks.requireOperationAccess.mockResolvedValue(undefined)
    mocks.fetchQuery
      .mockResolvedValueOnce({
        defaultLocale: "en",
        languageVersion: 7,
      })
      .mockResolvedValueOnce([{ locale: "en", url: "/about", indexable: true }])
  })

  test("denies before public URL reads and cache invalidation", async () => {
    mocks.requireOperationAccess.mockRejectedValue(
      new Error("Operation denied")
    )

    await expect(revalidatePagePaths("page-id" as never)).rejects.toThrow(
      "Operation denied"
    )
    expect(mocks.fetchQuery).not.toHaveBeenCalled()
    expect(mocks.revalidateTag).not.toHaveBeenCalled()
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  test("allows an operation principal to read and invalidate paths", async () => {
    await expect(
      revalidatePagePaths("page-id" as never)
    ).resolves.toBeUndefined()

    expect(mocks.requireOperationAccess).toHaveBeenCalledWith(
      "You do not have access to publish pages."
    )
    expect(mocks.fetchQuery).toHaveBeenCalledTimes(2)
    expect(mocks.fetchQuery).toHaveBeenNthCalledWith(2, expect.anything(), {
      pageId: "page-id",
      languageVersion: 7,
    })
    expect(mocks.revalidateTag).toHaveBeenCalledTimes(2)
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/en/about")
  })
})
