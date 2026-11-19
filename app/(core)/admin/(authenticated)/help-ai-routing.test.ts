// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  isLocalDevelopment: vi.fn(),
  isLocalToolRequest: vi.fn(),
  readDevAiSelection: vi.fn(),
  requireInstallationOwner: vi.fn(),
}))

vi.mock("@/lib/owner-server", () => ({
  requireInstallationOwner: mocks.requireInstallationOwner,
}))

vi.mock("@/lib/assert-local-dev", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assert-local-dev")>()),
  isLocalDevelopment: mocks.isLocalDevelopment,
}))

vi.mock("@/lib/local-request", () => ({
  isLocalToolRequest: mocks.isLocalToolRequest,
}))

vi.mock("@/scripts/lib/dev-ai-selection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/scripts/lib/dev-ai-selection")>()),
  readDevAiSelection: mocks.readDevAiSelection,
}))

import { loadDevGroundedHelpRoute } from "./help-ai-routing"

const helpOn = (engine: "claude" | "codex") => ({
  version: 3,
  engine: "openrouter",
  tasks: { "grounded-help": { engine, model: "m", effort: "low" } },
})

describe("loadDevGroundedHelpRoute", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isLocalDevelopment.mockReturnValue(true)
    mocks.isLocalToolRequest.mockResolvedValue(true)
    mocks.requireInstallationOwner.mockResolvedValue({ authId: "owner" })
  })

  test.each(["claude", "codex"] as const)(
    "a %s choice for Help is ready on this computer",
    async (engine) => {
      mocks.readDevAiSelection.mockReturnValue(helpOn(engine))
      await expect(loadDevGroundedHelpRoute()).resolves.toEqual({
        kind: "selected-ready",
        engine,
      })
    }
  )

  test.each(["claude", "codex"] as const)(
    "a %s choice cannot run on another device; it never becomes the live-site route",
    async (engine) => {
      mocks.isLocalToolRequest.mockResolvedValue(false)
      mocks.readDevAiSelection.mockReturnValue(helpOn(engine))
      await expect(loadDevGroundedHelpRoute()).resolves.toEqual({
        kind: "selected-other-device",
      })
      expect(mocks.readDevAiSelection).not.toHaveBeenCalled()
    }
  )

  test("anyone but the owner gets no usable Help and no local read", async () => {
    mocks.requireInstallationOwner.mockRejectedValue(new Error("owner only"))
    mocks.readDevAiSelection.mockReturnValue(helpOn("claude"))
    await expect(loadDevGroundedHelpRoute()).resolves.toEqual({
      kind: "selected-needs-setup",
    })
    expect(mocks.isLocalToolRequest).not.toHaveBeenCalled()
    expect(mocks.readDevAiSelection).not.toHaveBeenCalled()
  })

  test.each([
    ["no local file", null],
    ["a top-level local tool", { version: 3, engine: "claude" }],
    [
      "a per-task API engine",
      { version: 3, engine: "claude", tasks: { "grounded-help": { engine: "openai" } } },
    ],
  ])("%s keeps Help on the live-site route", async (_label, selection) => {
    mocks.readDevAiSelection.mockReturnValue(selection)
    await expect(loadDevGroundedHelpRoute()).resolves.toEqual({
      kind: "production",
    })
  })

  test("a malformed local file needs setup", async () => {
    mocks.readDevAiSelection.mockImplementation(() => {
      throw new Error("corrupt selection")
    })
    await expect(loadDevGroundedHelpRoute()).resolves.toEqual({
      kind: "selected-needs-setup",
    })
  })

  test("uses the live-site route outside local development without reading machine state", async () => {
    mocks.isLocalDevelopment.mockReturnValue(false)
    await expect(loadDevGroundedHelpRoute()).resolves.toEqual({
      kind: "production",
    })
    expect(mocks.readDevAiSelection).not.toHaveBeenCalled()
    expect(mocks.isLocalToolRequest).not.toHaveBeenCalled()
  })
})
