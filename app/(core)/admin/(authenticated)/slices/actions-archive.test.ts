import { sliceProfileAny } from "@/test-utils/slice-profile"
// @vitest-environment node
import { getFunctionName } from "convex/server"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { INSTALLED_SLICE_TYPES } from "@/convex/lib/slices"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  requireInstallationOwner: vi.fn(),
  mutation: vi.fn(),
  query: vi.fn(),
  revalidate: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }))
vi.mock("@/lib/auth-server", () => ({
  requireAuth: mocks.requireAuth,
  fetchAuthMutation: mocks.mutation,
  fetchAuthQuery: mocks.query,
}))
vi.mock("@/lib/owner-server", () => ({
  requireInstallationOwner: mocks.requireInstallationOwner,
}))
vi.mock("./gate", () => ({ runSliceGate: vi.fn(), runTypecheckGate: vi.fn() }))

import { setSliceArchivedAction } from "./actions"

const requests = INSTALLED_SLICE_TYPES.flatMap((type) =>
  [true, false].map((archived) => ({ type, archived }))
)

beforeEach(() => {
  vi.resetAllMocks()
  mocks.requireAuth.mockResolvedValue(undefined)
  mocks.requireInstallationOwner.mockResolvedValue(undefined)
})
afterEach(() => vi.unstubAllEnvs())

describe.skipIf(requests.length === 0).each(["development", "test"] as const)("%s archive/restore", sliceProfileAny(requests.map(({ type }) => type)), (env) => {
  beforeEach(() => vi.stubEnv("NODE_ENV", env))

  test.skipIf(requests.length === 0).each(requests)(
    "forwards $type archived=$archived for the owner", sliceProfileAny(requests.map(({ type }) => type)),
    async (args) => {
      await expect(setSliceArchivedAction(args)).resolves.toBeUndefined()
      expect(mocks.requireAuth).toHaveBeenCalledWith(
        "Sign in to manage blocks."
      )
      expect(mocks.requireInstallationOwner).toHaveBeenCalledWith(
        "Only the installation owner can edit blocks."
      )
      expect(mocks.mutation).toHaveBeenCalledOnce()
      const [reference, forwarded] = mocks.mutation.mock.calls[0]
      expect(getFunctionName(reference)).toBe(
        "cms/sliceLibrary:setSliceArchived"
      )
      expect(forwarded).toEqual(args)
      expect(mocks.revalidate.mock.calls).toEqual([
        ["/admin/slices"],
        [`/admin/slices/${args.type}`],
      ])
      const order = [
        mocks.requireAuth,
        mocks.requireInstallationOwner,
        mocks.mutation,
        mocks.revalidate,
      ].map((mock) => mock.mock.invocationCallOrder[0])
      expect(order).toEqual([...order].sort((a, b) => a - b))
      expect(mocks.query).not.toHaveBeenCalled()
    }
  )
})

test.skipIf(requests.length === 0).each(requests)(
  "production refuses $type archived=$archived before any write", sliceProfileAny(requests.map(({ type }) => type)),
  async (args) => {
    vi.stubEnv("NODE_ENV", "production")
    await expect(setSliceArchivedAction(args)).rejects.toThrow(
      "Slice edits is only available in local development."
    )
    expect(mocks.requireAuth).toHaveBeenCalledOnce()
    expect(mocks.requireInstallationOwner).not.toHaveBeenCalled()
    expect(mocks.mutation).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.revalidate).not.toHaveBeenCalled()
  }
)

test.each(["authentication", "owner"] as const)(
  "%s refusal prevents writes",
  async (guard) => {
    vi.stubEnv("NODE_ENV", "development")
    const error = new Error(`${guard} refused`)
    if (guard === "authentication") mocks.requireAuth.mockRejectedValue(error)
    else mocks.requireInstallationOwner.mockRejectedValue(error)
    await expect(setSliceArchivedAction(requests[0] ?? { type: "uninstalled-fixture", archived: false })).rejects.toBe(error)
    expect(mocks.mutation).not.toHaveBeenCalled()
    expect(mocks.revalidate).not.toHaveBeenCalled()
    if (guard === "authentication") {
      expect(mocks.requireInstallationOwner).not.toHaveBeenCalled()
    }
  }
)
