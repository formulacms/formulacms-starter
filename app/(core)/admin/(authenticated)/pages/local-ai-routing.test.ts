// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  isLocalDevelopment: vi.fn(),
  isLocalToolRequest: vi.fn(),
  readDevAiSelection: vi.fn(),
  resolveDevAiTaskSelection: vi.fn(),
  requireInstallationOwner: vi.fn(),
  spawn: vi.fn(),
  execFile: vi.fn(),
  readFileSync: vi.fn(),
}))

// Generic fallback for the guards: any process start or file read that is not
// one of the named seams above is recorded here.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
  execFile: mocks.execFile,
}))
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  mocks.readFileSync.mockImplementation(actual.readFileSync as never)
  return { ...actual, readFileSync: mocks.readFileSync }
})
const assertNoLocalEffect = () => {
  expect(mocks.readDevAiSelection).not.toHaveBeenCalled()
  expect(mocks.readFileSync).not.toHaveBeenCalled()
  expect(mocks.spawn).not.toHaveBeenCalled()
  expect(mocks.execFile).not.toHaveBeenCalled()
}

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
  resolveDevAiTaskSelection: mocks.resolveDevAiTaskSelection,
}))

import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import {
  loadDevPageAiRouting,
  loadLocalToolChoice,
  loadLocalToolEngine,
  LocalToolRefusedError,
  resolveLocalAiRoute,
} from "./local-ai-routing"

describe("loadDevPageAiRouting", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isLocalDevelopment.mockReturnValue(true)
    mocks.isLocalToolRequest.mockResolvedValue(true)
    mocks.requireInstallationOwner.mockResolvedValue({ authId: "owner" })
    mocks.readDevAiSelection.mockReturnValue({ version: 3, engine: "claude" })
    mocks.resolveDevAiTaskSelection.mockImplementation(
      (_selection, profile: string) =>
        profile === "mechanical-translation"
          ? { engine: "codex" }
          : profile === "brand-translation"
            ? { engine: "openrouter" }
            : { engine: "anthropic" }
    )
  })

  test("exposes mechanical, brand, and editorial routes from one saved selection read", async () => {
    await expect(loadDevPageAiRouting()).resolves.toEqual({
      mechanicalTranslation: { engine: "codex" },
      brandTranslation: { engine: "openrouter" },
      editorialCopy: { engine: "anthropic" },
      structuredOutlineMeta: { engine: "anthropic" },
    })
    expect(mocks.readDevAiSelection).toHaveBeenCalledOnce()
    expect(mocks.resolveDevAiTaskSelection).toHaveBeenCalledTimes(4)
  })

  test("passes an absent selection through to the default route resolver", async () => {
    mocks.readDevAiSelection.mockReturnValue(null)
    mocks.resolveDevAiTaskSelection.mockReturnValue({ engine: "openrouter" })

    await expect(loadDevPageAiRouting()).resolves.toEqual({
      mechanicalTranslation: { engine: "openrouter" },
      brandTranslation: { engine: "openrouter" },
      editorialCopy: { engine: "openrouter" },
      structuredOutlineMeta: { engine: "openrouter" },
    })
    expect(mocks.resolveDevAiTaskSelection).toHaveBeenNthCalledWith(
      1,
      null,
      "mechanical-translation"
    )
    expect(mocks.resolveDevAiTaskSelection).toHaveBeenNthCalledWith(
      2,
      null,
      "brand-translation"
    )
    expect(mocks.resolveDevAiTaskSelection).toHaveBeenNthCalledWith(
      3,
      null,
      "editorial-copy"
    )
    expect(mocks.resolveDevAiTaskSelection).toHaveBeenNthCalledWith(
      4,
      null,
      "structured-outline-meta"
    )
  })

  test("keeps each off or invalid profile unavailable without hiding the other", async () => {
    mocks.resolveDevAiTaskSelection.mockImplementation(
      (_selection, profile: string) => {
        if (profile === "mechanical-translation") {
          throw new Error("invalid mechanical override")
        }
        return { engine: "off" }
      }
    )

    await expect(loadDevPageAiRouting()).resolves.toEqual({
      mechanicalTranslation: null,
      brandTranslation: null,
      editorialCopy: null,
      structuredOutlineMeta: null,
    })
  })

  test("a request that is not loopback sees no route and never reads the local file", async () => {
    mocks.isLocalToolRequest.mockResolvedValue(false)

    await expect(loadDevPageAiRouting()).resolves.toEqual({
      mechanicalTranslation: null,
      brandTranslation: null,
      editorialCopy: null,
      structuredOutlineMeta: null,
    })
    assertNoLocalEffect()
    expect(mocks.resolveDevAiTaskSelection).not.toHaveBeenCalled()
  })

  test("anyone but the owner sees no route; neither the request nor the file is read", async () => {
    mocks.requireInstallationOwner.mockRejectedValue(new Error("owner only"))

    await expect(loadDevPageAiRouting()).resolves.toEqual({
      mechanicalTranslation: null,
      brandTranslation: null,
      editorialCopy: null,
      structuredOutlineMeta: null,
    })
    expect(mocks.isLocalToolRequest).not.toHaveBeenCalled()
    assertNoLocalEffect()
  })

  test("reads no machine-local state outside local development", async () => {
    mocks.isLocalDevelopment.mockReturnValue(false)

    await expect(loadDevPageAiRouting()).resolves.toEqual({
      mechanicalTranslation: null,
      brandTranslation: null,
      editorialCopy: null,
      structuredOutlineMeta: null,
    })
    expect(mocks.readDevAiSelection).not.toHaveBeenCalled()
    expect(mocks.resolveDevAiTaskSelection).not.toHaveBeenCalled()
    expect(mocks.isLocalToolRequest).not.toHaveBeenCalled()
  })

  test("keeps routes unavailable when the saved selection is corrupt", async () => {
    mocks.readDevAiSelection.mockImplementation(() => {
      throw new Error("corrupt selection")
    })

    await expect(loadDevPageAiRouting()).resolves.toEqual({
      mechanicalTranslation: null,
      brandTranslation: null,
      editorialCopy: null,
      structuredOutlineMeta: null,
    })
    expect(mocks.resolveDevAiTaskSelection).not.toHaveBeenCalled()
  })
})

describe("resolveLocalAiRoute (the one route check for routing and actions)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isLocalDevelopment.mockReturnValue(true)
    mocks.isLocalToolRequest.mockResolvedValue(true)
    mocks.requireInstallationOwner.mockResolvedValue({ authId: "owner" })
    mocks.readDevAiSelection.mockReturnValue({ version: 3, engine: "claude" })
  })

  for (const engine of ["claude", "codex"] as const) {
    test(`returns ${engine} for a request from this computer`, async () => {
      mocks.resolveDevAiTaskSelection.mockReturnValue({ engine, model: "m" })

      await expect(resolveLocalAiRoute("editorial-copy")).resolves.toEqual({
        engine,
        model: "m",
      })
      expect(mocks.resolveDevAiTaskSelection).toHaveBeenCalledWith(
        { version: 3, engine: "claude" },
        "editorial-copy"
      )
    })
  }

  test.each(["mechanical-translation", "brand-translation", "editorial-copy", "structured-outline-meta"] as const)(
    "%s from another device takes the production route without reading the local file",
    async (profile) => {
      mocks.isLocalToolRequest.mockResolvedValue(false)

      await expect(resolveLocalAiRoute(profile)).resolves.toEqual({ engine: "off" })
      assertNoLocalEffect()
      expect(mocks.resolveDevAiTaskSelection).not.toHaveBeenCalled()
    }
  )

  test.each(["grounded-help", "vision-spec", "renderer-jsx"] as const)(
    "%s from another device is refused without reading the local file",
    async (profile) => {
      mocks.isLocalToolRequest.mockResolvedValue(false)

      await expect(resolveLocalAiRoute(profile)).rejects.toBeInstanceOf(
        LocalToolRefusedError
      )
      assertNoLocalEffect()
    }
  )

  test("checks the owner first: anyone else reads neither the request nor the file", async () => {
    mocks.requireInstallationOwner.mockRejectedValue(new Error("owner only"))

    await expect(resolveLocalAiRoute("grounded-help")).rejects.toThrow("owner only")
    expect(mocks.isLocalToolRequest).not.toHaveBeenCalled()
    assertNoLocalEffect()
  })

  test("returns API and Off routes for a request from this computer", async () => {
    mocks.resolveDevAiTaskSelection.mockReturnValueOnce({ engine: "openai" })
    mocks.resolveDevAiTaskSelection.mockReturnValueOnce({ engine: "off" })

    await expect(resolveLocalAiRoute("editorial-copy")).resolves.toEqual({
      engine: "openai",
    })
    await expect(resolveLocalAiRoute("editorial-copy")).resolves.toEqual({
      engine: "off",
    })
  })

  test("is Off outside local development without reading the selection or the request", async () => {
    mocks.isLocalDevelopment.mockReturnValue(false)

    await expect(resolveLocalAiRoute("grounded-help")).resolves.toEqual({
      engine: "off",
    })
    expect(mocks.readDevAiSelection).not.toHaveBeenCalled()
    expect(mocks.isLocalToolRequest).not.toHaveBeenCalled()
    expect(mocks.requireInstallationOwner).not.toHaveBeenCalled()
  })

  test("is the only reader of the saved local route under the admin", () => {
    const adminRoot = join(process.cwd(), "app/(core)/admin/(authenticated)")
    const files = (readdirSync(adminRoot, { recursive: true }) as string[])
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .map((file) => join(adminRoot, file))
    const readers = files
      .filter((file) =>
        /\b(readDevAiSelection|resolveDevAiTaskSelection)\(/.test(
          readFileSync(file, "utf8")
        )
      )
      .map((file) => relative(adminRoot, file))
      .sort()
    expect(readers).toEqual(["pages/local-ai-routing.ts"])
  })
})

describe("Help and the Block creator take only their Settings › AI choice", () => {
  const ASSISTANT_PROFILES = ["grounded-help", "vision-spec", "renderer-jsx"] as const
  const choice = { engine: "codex", model: "gpt-6.1-sol", effort: "high" } as const

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isLocalDevelopment.mockReturnValue(true)
    mocks.isLocalToolRequest.mockResolvedValue(true)
    mocks.requireInstallationOwner.mockResolvedValue({ authId: "owner" })
    mocks.resolveDevAiTaskSelection.mockReturnValue({ engine: "claude" })
  })

  test.each([
    ["no local file", null],
    ["a top-level local tool", { version: 3, engine: "claude", model: "opus", effort: "high" }],
    ["a top-level API engine", { version: 3, engine: "anthropic" }],
    [
      "a per-task API engine",
      {
        version: 3,
        engine: "claude",
        tasks: {
          "grounded-help": { engine: "openrouter" },
          "vision-spec": { engine: "openai" },
          "renderer-jsx": { engine: "anthropic" },
        },
      },
    ],
  ])("%s leaves them on their API route", async (_label, selection) => {
    mocks.readDevAiSelection.mockReturnValue(selection)
    for (const profile of ASSISTANT_PROFILES) {
      await expect(resolveLocalAiRoute(profile)).resolves.toEqual({ engine: "off" })
    }
    // Page tasks keep the file's own rule.
    await expect(resolveLocalAiRoute("editorial-copy")).resolves.toEqual({
      engine: "claude",
    })
    expect(mocks.resolveDevAiTaskSelection).toHaveBeenCalledOnce()
  })

  test("the saved choice runs them; both Block creator steps use one choice", async () => {
    mocks.readDevAiSelection.mockReturnValue({
      version: 3,
      engine: "openrouter",
      tasks: { "grounded-help": choice, "vision-spec": choice, "renderer-jsx": choice },
    })
    for (const profile of ASSISTANT_PROFILES) {
      await expect(resolveLocalAiRoute(profile)).resolves.toEqual(choice)
    }
    expect(mocks.resolveDevAiTaskSelection).not.toHaveBeenCalled()
  })

  test("from another device both are refused, never replaced by an API service", async () => {
    mocks.isLocalToolRequest.mockResolvedValue(false)
    mocks.readDevAiSelection.mockReturnValue({
      version: 3,
      engine: "openrouter",
      tasks: { "vision-spec": choice, "renderer-jsx": choice },
    })
    for (const profile of ASSISTANT_PROFILES) {
      await expect(resolveLocalAiRoute(profile)).rejects.toBeInstanceOf(
        LocalToolRefusedError
      )
    }
    expect(mocks.readDevAiSelection).not.toHaveBeenCalled()
  })
})

describe("Writing and Translation: the choice for their whole-page jobs", () => {
  const writing = { engine: "claude", model: "claude-sonnet-5-5", effort: "medium" } as const
  const withWriting = {
    version: 3,
    engine: "codex",
    tasks: { "editorial-copy": writing, "structured-outline-meta": writing },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isLocalDevelopment.mockReturnValue(true)
    mocks.isLocalToolRequest.mockResolvedValue(true)
    mocks.requireInstallationOwner.mockResolvedValue({ authId: "owner" })
    mocks.readDevAiSelection.mockReturnValue(withWriting)
  })

  test("only the Settings › AI choice counts, never the top-level engine", async () => {
    await expect(loadLocalToolChoice("writing")).resolves.toEqual(writing)
    // A top-level local tool alone does not run Translation locally.
    await expect(loadLocalToolChoice("translation")).resolves.toBeNull()
    expect(mocks.resolveDevAiTaskSelection).not.toHaveBeenCalled()
  })

  test("another device is refused without reading the file", async () => {
    mocks.isLocalToolRequest.mockResolvedValue(false)
    await expect(loadLocalToolChoice("writing")).rejects.toBeInstanceOf(LocalToolRefusedError)
    assertNoLocalEffect()
  })

  test("the owner check comes first", async () => {
    mocks.requireInstallationOwner.mockRejectedValue(new Error("owner only"))
    await expect(loadLocalToolChoice("writing")).rejects.toThrow("owner only")
    expect(mocks.isLocalToolRequest).not.toHaveBeenCalled()
    assertNoLocalEffect()
  })

  test("route data: the engine here, null here on an API service, null elsewhere", async () => {
    await expect(loadLocalToolEngine("writing")).resolves.toEqual({ engine: "claude" })
    await expect(loadLocalToolEngine("translation")).resolves.toEqual({ engine: null })
    mocks.isLocalToolRequest.mockResolvedValue(false)
    await expect(loadLocalToolEngine("writing")).resolves.toBeNull()
    mocks.isLocalDevelopment.mockReturnValue(false)
    await expect(loadLocalToolEngine("writing")).resolves.toBeNull()
  })

  test("the field actions keep the page-task rule: another device takes the production route", async () => {
    mocks.isLocalToolRequest.mockResolvedValue(false)
    await expect(resolveLocalAiRoute("editorial-copy")).resolves.toEqual({ engine: "off" })
  })
})
