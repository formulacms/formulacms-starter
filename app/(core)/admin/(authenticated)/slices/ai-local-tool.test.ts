// @vitest-environment node
// The Block creator on the local tool chosen in Settings › AI (ADR-0057).
// The engine factory is replaced, so no `claude` or `codex` command runs.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createEngine: vi.fn(),
  generate: vi.fn(),
  generateWithLocalApi: vi.fn(),
  createLocalAccounting: vi.fn(),
  fetchAuthQuery: vi.fn(),
  fetchAuthMutation: vi.fn(),
  isLocalToolRequest: vi.fn(),
  readDevAiSelection: vi.fn(),
  keyPresence: vi.fn(),
  requireInstallationOwner: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("@/lib/assert-local-dev", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assert-local-dev")>()),
  assertLocalDevelopment: vi.fn(),
  isLocalDevelopment: () => true,
}))
vi.mock("@/lib/local-request", () => ({
  isLocalToolRequest: mocks.isLocalToolRequest,
}))
vi.mock("@/lib/auth/server", () => ({
  fetchAuthQuery: mocks.fetchAuthQuery,
  fetchAuthMutation: mocks.fetchAuthMutation,
}))
vi.mock("@/lib/owner-server", () => ({
  requireInstallationOwner: mocks.requireInstallationOwner,
}))
vi.mock("@/lib/local-api-keys-file", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/local-api-keys-file")>()),
  localProviderKeyPresenceNow: mocks.keyPresence,
}))
vi.mock("@/scripts/lib/dev-ai-selection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/scripts/lib/dev-ai-selection")>()),
  readDevAiSelection: mocks.readDevAiSelection,
}))
vi.mock("@/scripts/lib/ai-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/scripts/lib/ai-engine")>()),
  createEngine: mocks.createEngine,
}))
vi.mock("@/scripts/lib/ai-api-engine", () => ({
  generateWithLocalApi: mocks.generateWithLocalApi,
}))
vi.mock("@/lib/ai/local-accounting", () => ({
  createLocalAccounting: mocks.createLocalAccounting,
}))
// The funding lookup runs the tool's status command; never here.
vi.mock("@/lib/ai/local-tool-funding", () => ({
  fundingForAuditEngine: async (engine: string) =>
    engine === "claude-cli" || engine === "codex-cli" ? "plan" : undefined,
}))
vi.mock("@/convex/lib/localAiAuditProof", () => ({
  signLocalAiAudit: async (event: object) => event,
}))
vi.mock("@/convex/lib/slices/presentations", () => ({
  readSlicePresentationCatalog: async () => ({
    installedTypes: [],
    contractDigests: {},
  }),
}))

import { getFunctionName } from "convex/server"
import {
  createSliceRendererProposalDev,
  createTextSliceProposalDev,
} from "./ai-actions"
import { LOCAL_TOOL_REFUSED_MESSAGE } from "../pages/local-ai-routing"

const CODEX = { engine: "codex", model: "gpt-6.1-sol", effort: "high" } as const
const SAVED = { choices: [], defaults: {}, catalog: [], instructions: "Keep it short." }

function blockCreatorOn(choice: object | null) {
  mocks.readDevAiSelection.mockReturnValue({
    version: 3,
    engine: "openrouter",
    ...(choice ? { tasks: { "vision-spec": choice, "renderer-jsx": choice } } : {}),
  })
}

const auditRows = () =>
  mocks.fetchAuthMutation.mock.calls
    .filter(([ref]) => getFunctionName(ref) === "agents/localGeneration:recordAudit")
    .map(([, row]) => row)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireInstallationOwner.mockResolvedValue({ authId: "owner-auth" })
  mocks.isLocalToolRequest.mockResolvedValue(true)
  mocks.fetchAuthQuery.mockResolvedValue(SAVED)
  mocks.keyPresence.mockReturnValue({ anthropic: false, openrouter: false, openai: false })
  blockCreatorOn(CODEX)
  mocks.generate.mockResolvedValue({
    text: "The proposal",
    output: "",
    selected: { lane: "local-build", engine: "codex-cli", model: "gpt-6.1-sol", effort: "high" },
    identityEvidence: "selected-only",
    attempts: 1,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    finishReason: "stop",
  })
  mocks.createEngine.mockReturnValue({ id: "codex", generate: mocks.generate })
})

describe("Block creator on a local tool", () => {
  test("runs the tool with the saved model and effort; no API engine, no accounting", async () => {
    await expect(
      createTextSliceProposalDev({ brief: "A pricing table" })
    ).resolves.toEqual({
      proposal: "The proposal",
      specJson: null,
      decomposition: null,
      modelId: "gpt-6.1-sol",
    })
    expect(mocks.createEngine).toHaveBeenCalledWith("codex", {
      engineModel: "gpt-6.1-sol",
      engineEffort: "high",
    })
    const request = mocks.generate.mock.calls[0]![0]
    expect(request).toMatchObject({ profile: "vision-spec", phase: "slice-spec", images: [] })
    expect(request.instructions.startsWith("Keep it short.\n\n")).toBe(true)
    expect(mocks.generateWithLocalApi).not.toHaveBeenCalled()
    expect(mocks.createLocalAccounting).not.toHaveBeenCalled()
  })

  test("writes the audit row with the step kind and how the run was funded", async () => {
    await createSliceRendererProposalDev({ specJson: '{"type":"x"}' })
    expect(auditRows()).toEqual([
      expect.objectContaining({
        kind: "slice-renderer",
        selectedEngine: "codex-cli",
        selectedModel: "gpt-6.1-sol",
        selectedReasoning: "high",
        identityEvidence: "selected-only",
        funding: "plan",
        attempts: 1,
        success: true,
      }),
    ])
    expect(mocks.generate.mock.calls[0]![0]).toMatchObject({
      profile: "renderer-jsx",
      phase: "renderer-jsx",
    })
  })

  test("a failed run is audited and its error reaches the caller", async () => {
    const failure = Object.assign(new Error("signed out"), {
      category: "AUTH_REQUIRED",
      attempts: 1,
    })
    mocks.generate.mockRejectedValue(failure)
    await expect(createTextSliceProposalDev({ brief: "A hero" })).rejects.toBe(failure)
    expect(auditRows()).toEqual([
      expect.objectContaining({
        kind: "slice-spec",
        selectedEngine: "codex-cli",
        success: false,
        errorCode: "AUTH_REQUIRED",
        funding: "plan",
      }),
    ])
    expect(mocks.generateWithLocalApi).not.toHaveBeenCalled()
  })

  test("another device is refused: no tool, no API engine", async () => {
    mocks.isLocalToolRequest.mockResolvedValue(false)
    mocks.keyPresence.mockReturnValue({ anthropic: true, openrouter: true, openai: true })
    await expect(createTextSliceProposalDev({ brief: "A hero" })).rejects.toThrow(
      LOCAL_TOOL_REFUSED_MESSAGE
    )
    expect(mocks.readDevAiSelection).not.toHaveBeenCalled()
    expect(mocks.createEngine).not.toHaveBeenCalled()
    expect(mocks.generateWithLocalApi).not.toHaveBeenCalled()
  })

  test("anyone but the owner: no local read, no tool, no Convex AI call", async () => {
    mocks.requireInstallationOwner.mockRejectedValue(new Error("owner only"))
    await expect(createTextSliceProposalDev({ brief: "A hero" })).rejects.toThrow("owner only")
    expect(mocks.isLocalToolRequest).not.toHaveBeenCalled()
    expect(mocks.readDevAiSelection).not.toHaveBeenCalled()
    expect(mocks.createEngine).not.toHaveBeenCalled()
    expect(mocks.generateWithLocalApi).not.toHaveBeenCalled()
    expect(mocks.fetchAuthQuery).not.toHaveBeenCalled()
    expect(mocks.fetchAuthMutation).not.toHaveBeenCalled()
  })

  test("without a choice the API route runs as before; the tool never does", async () => {
    blockCreatorOn(null)
    mocks.keyPresence.mockReturnValue({ anthropic: false, openrouter: false, openai: true })
    mocks.generateWithLocalApi.mockResolvedValue({
      text: "API proposal",
      selected: { model: "gpt-x" },
    })
    await expect(
      createTextSliceProposalDev({ brief: "A hero" })
    ).resolves.toMatchObject({ proposal: "API proposal", modelId: "gpt-x" })
    expect(mocks.generateWithLocalApi.mock.calls[0]![0]).toMatchObject({
      provider: "openai",
      profile: "vision-spec",
    })
    expect(mocks.createLocalAccounting).toHaveBeenCalledOnce()
    expect(mocks.createEngine).not.toHaveBeenCalled()
    expect(auditRows()).toEqual([])
  })
})

// Guard (d): a tool run can outlive the 60-second access token. The owner is
// authorized when the step starts; the audit after the run is signed with
// that owner, that start time and the step's own attempt identifier, and no
// owner check runs after the run (it would fail on the expired token).
describe("audit after the session token expired during the run", () => {
  const START = Date.UTC(2026, 10, 15, 12, 0, 0)

  beforeEach(() => {
    vi.useFakeTimers({ now: START, toFake: ["Date"] })
    mocks.generate.mockImplementation(async () => {
      vi.setSystemTime(START + 4 * 60_000)
      // From now on the token is expired: an owner check would fail.
      mocks.requireInstallationOwner.mockRejectedValue(new Error("expired"))
      return {
        text: "The proposal",
        output: "",
        selected: { lane: "local-build", engine: "codex-cli", model: "gpt-6.1-sol", effort: "high" },
        identityEvidence: "selected-only",
        attempts: 1,
        usage: {},
        finishReason: "stop",
      }
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test.each([
    ["the spec step", () => createTextSliceProposalDev({ brief: "A hero" })],
    ["the renderer step", () => createSliceRendererProposalDev({ specJson: '{"type":"x"}' })],
  ])("%s still records its audit with the start-time authorization", async (_label, run) => {
    await expect(run()).resolves.toMatchObject({ proposal: "The proposal" })
    const rows = auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      authId: "owner-auth",
      authorizedAt: START,
      attemptId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      success: true,
    })
  })

  test("a failed long run is audited the same way", async () => {
    mocks.generate.mockImplementation(async () => {
      vi.setSystemTime(START + 4 * 60_000)
      mocks.requireInstallationOwner.mockRejectedValue(new Error("expired"))
      throw Object.assign(new Error("timeout"), { category: "TIMEOUT", attempts: 1 })
    })
    await expect(createTextSliceProposalDev({ brief: "A hero" })).rejects.toThrow("timeout")
    expect(auditRows()).toEqual([
      expect.objectContaining({
        authId: "owner-auth",
        authorizedAt: START,
        attemptId: expect.any(String),
        success: false,
        errorCode: "TIMEOUT",
      }),
    ])
  })

  test("each step signs its own attempt identifier", async () => {
    mocks.requireInstallationOwner.mockResolvedValue({ authId: "owner-auth" })
    mocks.generate.mockResolvedValue({
      text: "The proposal",
      output: "",
      selected: { lane: "local-build", engine: "codex-cli", model: "gpt-6.1-sol", effort: "high" },
      identityEvidence: "selected-only",
      attempts: 1,
      usage: {},
      finishReason: "stop",
    })
    await createTextSliceProposalDev({ brief: "A hero" })
    await createSliceRendererProposalDev({ specJson: '{"type":"x"}' })
    const [first, second] = auditRows() as { attemptId: string }[]
    expect(first!.attemptId).not.toBe(second!.attemptId)
  })
})
