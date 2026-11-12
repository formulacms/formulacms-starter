// @vitest-environment node
import { getFunctionName } from "convex/server"
import { beforeEach, expect, test, vi } from "vitest"
import type { SlicePresentationCatalog } from "@/convex/lib/slices/presentationResolution"

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  assertLocalDevelopment: vi.fn(),
  requireInstallationOwner: vi.fn(),
  mutation: vi.fn(),
  query: vi.fn(),
  revalidate: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }))
vi.mock("@/lib/assert-local-dev", () => ({
  assertLocalDevelopment: mocks.assertLocalDevelopment,
}))
vi.mock("@/lib/auth-server", () => ({
  requireAuth: mocks.requireAuth,
  fetchAuthMutation: mocks.mutation,
  fetchAuthQuery: mocks.query,
}))
vi.mock("@/lib/owner-server", () => ({
  requireInstallationOwner: mocks.requireInstallationOwner,
}))
vi.mock("@/convex/lib/slices", () => ({
  REGISTERED_SLICE_TYPES: ["hero-with-image"],
}))
vi.mock("./gate", () => ({
  runSliceGate: vi.fn(),
  runTypecheckGate: vi.fn(),
}))

import { setPresentationArchivedAction } from "./actions"

const request = {
  type: "hero-with-image",
  presentationId: "centered",
  archived: true,
  expectedCatalogRevision: "current-catalog-revision",
}

function catalog(archived: boolean): SlicePresentationCatalog {
  return {
    version: "slice-presentations-v1",
    revision: archived ? "archived-revision" : "restored-revision",
    installedTypes: ["hero-with-image"],
    contractDigests: { "hero-with-image": "owned-contract" },
    entries: [
      {
        type: "hero-with-image",
        id: "default",
        label: "Default",
        state: "active",
        installed: true,
        contractSha256: "owned-contract",
        rendererSource: "components/slices/hero-with-image.tsx",
      },
      {
        type: "hero-with-image",
        id: "centered",
        label: "Centered",
        state: archived ? "archived" : "active",
        installed: true,
        contractSha256: "owned-contract",
        rendererSource: "components/slices/hero-with-image-centered.tsx",
      },
    ],
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.requireAuth.mockResolvedValue(undefined)
  mocks.requireInstallationOwner.mockResolvedValue(undefined)
})

test.each([true, false])(
  "forwards archive=%s with the exact revision and returns the full trusted catalog",
  async (archived) => {
    const args = { ...request, archived }
    const result = catalog(archived)
    mocks.mutation.mockImplementation(async () => {
      expect(mocks.revalidate).not.toHaveBeenCalled()
      return result
    })

    await expect(setPresentationArchivedAction(args)).resolves.toBe(result)

    expect(mocks.requireAuth).toHaveBeenCalledWith("Sign in to manage blocks.")
    expect(mocks.assertLocalDevelopment).toHaveBeenCalledWith("Slice edits")
    expect(mocks.requireInstallationOwner).toHaveBeenCalledWith(
      "Only the installation owner can edit blocks."
    )
    expect(mocks.mutation).toHaveBeenCalledTimes(1)
    const [reference, forwarded] = mocks.mutation.mock.calls[0]
    expect(getFunctionName(reference)).toBe(
      "cms/slices:setPresentationArchived"
    )
    expect(forwarded).toEqual(args)
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.revalidate.mock.calls).toEqual([
      ["/admin/slices"],
      ["/admin/slices/hero-with-image"],
    ])
    const orderedCalls = [
      mocks.requireAuth,
      mocks.assertLocalDevelopment,
      mocks.requireInstallationOwner,
      mocks.mutation,
      mocks.revalidate,
    ].map((mock) => mock.mock.invocationCallOrder[0])
    expect(orderedCalls).toEqual([...orderedCalls].sort((a, b) => a - b))
  }
)

test.each(["authentication", "local development", "owner"] as const)(
  "%s refusal prevents mutation and revalidation",
  async (guard) => {
    const error = new Error(`${guard} refused`)
    if (guard === "authentication") mocks.requireAuth.mockRejectedValue(error)
    if (guard === "local development") {
      mocks.assertLocalDevelopment.mockImplementation(() => {
        throw error
      })
    }
    if (guard === "owner")
      mocks.requireInstallationOwner.mockRejectedValue(error)

    await expect(setPresentationArchivedAction(request)).rejects.toBe(error)

    expect(mocks.mutation).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.revalidate).not.toHaveBeenCalled()
    if (guard === "authentication") {
      expect(mocks.assertLocalDevelopment).not.toHaveBeenCalled()
    }
    if (guard !== "owner") {
      expect(mocks.requireInstallationOwner).not.toHaveBeenCalled()
    }
  }
)

test.each([
  "SLICE_PRESENTATION_CATALOG_STALE",
  "SLICE_PRESENTATION_SOURCE_UNAVAILABLE",
])("propagates U2 refusal %s without revalidation", async (code) => {
  const error = new Error(code)
  mocks.mutation.mockRejectedValue(error)

  await expect(setPresentationArchivedAction(request)).rejects.toBe(error)

  expect(mocks.mutation).toHaveBeenCalledTimes(1)
  expect(mocks.query).not.toHaveBeenCalled()
  expect(mocks.revalidate).not.toHaveBeenCalled()
})

test.each([true, false])(
  "does not undo a committed archive=%s when invalidation fails",
  async (archived) => {
    const args = { ...request, archived }
    const result = catalog(archived)
    let committed = catalog(!archived)
    const error = new Error("invalidation unavailable")
    mocks.mutation.mockImplementation(async () => {
      committed = result
      return result
    })
    mocks.revalidate.mockImplementationOnce(() => {
      throw error
    })

    await expect(setPresentationArchivedAction(args)).rejects.toBe(error)

    expect(committed).toBe(result)
    expect(mocks.mutation).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      args
    )
    expect(mocks.revalidate).toHaveBeenCalledExactlyOnceWith("/admin/slices")
    expect(mocks.mutation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.revalidate.mock.invocationCallOrder[0]
    )
    expect(mocks.query).not.toHaveBeenCalled()
  }
)
