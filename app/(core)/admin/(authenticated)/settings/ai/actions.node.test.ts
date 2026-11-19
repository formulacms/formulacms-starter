import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  requireInstallationOwner: vi.fn(),
  refresh: vi.fn(),
  assertLocalDevelopment: vi.fn(),
  isLocalToolRequest: vi.fn(async () => true),
  writeLocalToolChoices: vi.fn((changes: unknown) => changes),
  fetchAuthMutation: vi.fn(async () => null),
}))

vi.mock("@/lib/auth/server", () => ({
  fetchAuthMutation: mocks.fetchAuthMutation,
}))

vi.mock("@/lib/owner-server", () => ({
  requireInstallationOwner: mocks.requireInstallationOwner,
}))
vi.mock("next/cache", () => ({ refresh: mocks.refresh }))
vi.mock("@/lib/assert-local-dev", () => ({
  assertLocalDevelopment: mocks.assertLocalDevelopment,
}))
vi.mock("@/lib/local-request", () => ({
  isLocalToolRequest: mocks.isLocalToolRequest,
}))
vi.mock("@/scripts/lib/dev-ai-selection", async (importOriginal) => ({
  DEV_AI_CHOICES: ["claude"],
  parseLocalToolChoiceChanges: (await importOriginal<typeof import("@/scripts/lib/dev-ai-selection")>()).parseLocalToolChoiceChanges,
  assertOfferedLocalToolChoices: (await importOriginal<typeof import("@/scripts/lib/dev-ai-selection")>()).assertOfferedLocalToolChoices,
  writeLocalToolChoices: mocks.writeLocalToolChoices,
  parseDevAiSelection: vi.fn(),
  writeDevAiSelection: vi.fn(),
}))
// The committed lists: the test never reads the machine's `.formulacms/local/` mirror.
vi.mock("@/scripts/lib/local-tool-models", async () => ({
  peekLocalToolModels: (await vi.importActual<typeof import("@/scripts/lib/dev-ai-selection")>("@/scripts/lib/dev-ai-selection")).builtInLocalToolModels,
}))
vi.mock("@/scripts/lib/dev-ai-connections", () => ({
  validateDevAiConnection: vi.fn(),
}))

import {
  checkDevAiConnection,
  saveDevAiSelection,
  saveLocalToolChoices,
} from "./actions"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("AI settings server action authorization", () => {
  test("denies non-owners before local machine access", async () => {
    mocks.requireInstallationOwner.mockRejectedValueOnce(
      new Error("owner denied")
    )

    await expect(saveDevAiSelection({})).rejects.toThrow("owner denied")
    expect(mocks.assertLocalDevelopment).not.toHaveBeenCalled()

    mocks.requireInstallationOwner.mockRejectedValueOnce(
      new Error("owner denied")
    )
    await expect(checkDevAiConnection("claude")).rejects.toThrow("owner denied")
    expect(mocks.assertLocalDevelopment).not.toHaveBeenCalled()
  })
})

describe("saving local tool choices", () => {
  const choice = { help: { engine: "claude", model: "claude-haiku-5-5", effort: "low" } }

  test("a non-owner is refused before the request check or any write", async () => {
    mocks.requireInstallationOwner.mockRejectedValueOnce(new Error("owner denied"))
    await expect(saveLocalToolChoices(choice)).rejects.toThrow("owner denied")
    expect(mocks.isLocalToolRequest).not.toHaveBeenCalled()
    expect(mocks.writeLocalToolChoices).not.toHaveBeenCalled()
  })

  test("a request from another device is refused and nothing is written", async () => {
    mocks.isLocalToolRequest.mockResolvedValueOnce(false)
    await expect(saveLocalToolChoices(choice)).rejects.toThrow(/computer that runs formulacms/)
    expect(mocks.writeLocalToolChoices).not.toHaveBeenCalled()
  })

  test("the older local file and status actions refuse another device too", async () => {
    mocks.isLocalToolRequest.mockResolvedValueOnce(false)
    await expect(saveDevAiSelection({})).rejects.toThrow(/computer that runs formulacms/)
    mocks.isLocalToolRequest.mockResolvedValueOnce(false)
    await expect(checkDevAiConnection("claude")).rejects.toThrow(/computer that runs formulacms/)
  })

  test("an invalid payload is refused; a valid one is written", async () => {
    await expect(saveLocalToolChoices({ help: { engine: "openai", model: "x", effort: "low" } })).rejects.toThrow(/unknown local tool/)
    expect(mocks.writeLocalToolChoices).not.toHaveBeenCalled()
    expect(mocks.refresh).not.toHaveBeenCalled()
    await expect(saveLocalToolChoices(choice)).resolves.toEqual(choice)
    expect(mocks.writeLocalToolChoices).toHaveBeenCalledWith(choice)
  })

  test.each([
    ["a model never offered", { engine: "codex", model: "gpt-6-sol", effort: "high" }],
    ["a model the menu does not list", { engine: "codex", model: "gpt-9-unlisted", effort: "high" }],
    // A saved alias still runs, but is no longer chosen anew.
    ["a Claude alias", { engine: "claude", model: "haiku", effort: "low" }],
  ])("%s is refused and nothing is written", async (_name, help) => {
    await expect(saveLocalToolChoices({ help })).rejects.toThrow(/is not offered/)
    expect(mocks.writeLocalToolChoices).not.toHaveBeenCalled()
  })

  test("a saved choice refreshes the admin so Help runs on it without a reload", async () => {
    await saveLocalToolChoices(choice)
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })
})

describe("the Convex marker of Writing and Translation", () => {
  const sonnet = { engine: "claude", model: "claude-sonnet-5-5", effort: "medium" } as const
  const order = () =>
    [...mocks.fetchAuthMutation.mock.invocationCallOrder.map((at, index) => ({
      at,
      step: `marker ${JSON.stringify((mocks.fetchAuthMutation.mock.calls[index] as unknown[])[1])}`,
    })), ...mocks.writeLocalToolChoices.mock.invocationCallOrder.map((at) => ({ at, step: "file" }))]
      .sort((a, b) => a.at - b.at)
      .map(({ step }) => step)

  test("a local tool for Writing sets the marker first, then writes the file", async () => {
    await saveLocalToolChoices({ writing: sonnet })
    expect(order()).toEqual(['marker {"assistant":"writing","on":true}', "file"])
  })

  test("going back to an API service writes the file first, then clears the marker", async () => {
    await saveLocalToolChoices({ translation: null })
    expect(order()).toEqual(["file", 'marker {"assistant":"translation","on":false}'])
  })

  test("a failed marker write leaves the file unchanged and fails the save", async () => {
    mocks.fetchAuthMutation.mockRejectedValueOnce(new Error("marker refused"))
    await expect(saveLocalToolChoices({ writing: sonnet, help: null })).rejects.toThrow("marker refused")
    expect(mocks.writeLocalToolChoices).not.toHaveBeenCalled()
  })

  test("Help and the Block creator have no marker", async () => {
    await saveLocalToolChoices({ help: null, sliceCreator: null })
    expect(mocks.fetchAuthMutation).not.toHaveBeenCalled()
  })
})

describe("guard: two saves at once keep the file and the marker in agreement", () => {
  const sonnet = { engine: "claude", model: "claude-sonnet-5-5", effort: "medium" } as const
  type Assistant = "writing" | "translation"
  let file: Partial<Record<Assistant, unknown>>
  let marker: Partial<Record<Assistant, boolean>>
  // The next marker call waits for `release`. "commits-first": Convex commits
  // it at once and only its answer is late. "commits-late": it commits when
  // released.
  let deferNext: "commits-first" | "commits-late" | undefined
  let release: (() => void) | undefined

  beforeEach(() => {
    file = {}
    marker = {}
    deferNext = undefined
    release = undefined
    mocks.writeLocalToolChoices.mockImplementation((changes: unknown) => {
      Object.assign(file, changes)
      return { ...file }
    })
    mocks.fetchAuthMutation.mockImplementation((async (_ref: unknown, args: { assistant: Assistant; on: boolean }) => {
      const commit = () => {
        marker[args.assistant] = args.on
      }
      const mode = deferNext
      deferNext = undefined
      if (!mode) return commit()
      if (mode === "commits-first") commit()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      if (mode === "commits-late") commit()
      return null
    }) as never)
  })
  afterEach(() => {
    release?.()
    mocks.writeLocalToolChoices.mockImplementation((changes: unknown) => changes)
    mocks.fetchAuthMutation.mockImplementation(async () => null)
  })

  const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
  const agree = (assistant: Assistant) =>
    expect(marker[assistant] ?? false).toBe(Boolean(file[assistant]))

  test.each(["writing", "translation"] as const)(
    "%s: set local (late answer), then go back to the API service",
    async (assistant) => {
      deferNext = "commits-first"
      const a = saveLocalToolChoices({ [assistant]: sonnet })
      await vi.waitFor(() => expect(release).toBeDefined())
      const b = saveLocalToolChoices({ [assistant]: null })
      await settle()
      release!()
      await Promise.all([a, b])
      expect(file[assistant]).toBeNull()
      agree(assistant)
    }
  )

  test.each(["writing", "translation"] as const)(
    "%s: go back to the API service (late commit), then set local",
    async (assistant) => {
      file[assistant] = sonnet
      marker[assistant] = true
      deferNext = "commits-late"
      const a = saveLocalToolChoices({ [assistant]: null })
      await vi.waitFor(() => expect(release).toBeDefined())
      const b = saveLocalToolChoices({ [assistant]: sonnet })
      await settle()
      release!()
      await Promise.all([a, b])
      expect(file[assistant]).toEqual(sonnet)
      agree(assistant)
    }
  )

  test("a failed save releases the next one", async () => {
    mocks.fetchAuthMutation.mockRejectedValueOnce(new Error("marker refused"))
    await expect(saveLocalToolChoices({ writing: sonnet })).rejects.toThrow("marker refused")
    await saveLocalToolChoices({ translation: sonnet })
    expect(file.translation).toEqual(sonnet)
    agree("translation")
  })
})
