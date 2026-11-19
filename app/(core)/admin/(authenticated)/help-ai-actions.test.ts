// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { getFunctionName } from "convex/server"
import { ConvexError } from "convex/values"
import { AGENTS } from "@/convex/lib/agents/registry"

const mocks = vi.hoisted(() => ({
  requireInstallationOwner: vi.fn(async () => ({ authId: "owner-auth" })),
  assertLocalDevelopment: vi.fn(),
  createEngine: vi.fn(),
  fetchAuthAction: vi.fn(),
  fetchAuthMutation: vi.fn(),
  generate: vi.fn(),
  isLocalDevelopment: vi.fn(),
  isLocalToolRequest: vi.fn(async () => true),
  readDevAiSelection: vi.fn(),
  resolveDevAiTaskSelection: vi.fn(),
  signLocalAiAudit: vi.fn((event) => event),
}))

vi.mock("server-only", () => ({}))

// The owner check before any local effect, and the run-start authorization
// signed into the audit (`local-ai-audit.ts`).
vi.mock("@/lib/owner-server", () => ({
  requireInstallationOwner: mocks.requireInstallationOwner,
}))

vi.mock("@/lib/assert-local-dev", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assert-local-dev")>()),
  assertLocalDevelopment: mocks.assertLocalDevelopment,
  isLocalDevelopment: mocks.isLocalDevelopment,
}))

vi.mock("@/lib/local-request", () => ({
  isLocalToolRequest: mocks.isLocalToolRequest,
}))

vi.mock("@/lib/auth/server", () => ({
  fetchAuthAction: mocks.fetchAuthAction,
  fetchAuthMutation: mocks.fetchAuthMutation,
}))

vi.mock("@/scripts/lib/ai-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/scripts/lib/ai-engine")>()),
  createEngine: mocks.createEngine,
}))

vi.mock("@/scripts/lib/dev-ai-selection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/scripts/lib/dev-ai-selection")>()),
  readDevAiSelection: mocks.readDevAiSelection,
  resolveDevAiTaskSelection: mocks.resolveDevAiTaskSelection,
}))

// Help runs on a local tool only through the entry Settings › AI writes for
// it; any other route leaves Help on the live-site route.
function helpRoute(route: { engine: string; model?: string; effort?: string }) {
  mocks.readDevAiSelection.mockReturnValue({
    version: 3,
    engine: "openrouter",
    ...(route.engine === "off" ? {} : { tasks: { "grounded-help": route } }),
  })
}

vi.mock("@/convex/lib/localAiAuditProof", () => ({
  signLocalAiAudit: mocks.signLocalAiAudit,
}))

// The funding lookup runs the tool's status command; never in these tests.
// A local tool run is funded by the plan; an API engine carries no funding.
// `local-tool-funding-audit.test.ts` covers the real lookup.
vi.mock("@/lib/ai/local-tool-funding", () => ({
  fundingForAuditEngine: async (engine: string) =>
    engine === "claude-cli" || engine === "codex-cli" ? "plan" : undefined,
}))

import { answerHelpQuestion, askHelp } from "./help-ai-actions"
import { LOCAL_TOOL_REFUSED_MESSAGE } from "./pages/local-ai-routing"

describe("answerHelpQuestion", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isLocalDevelopment.mockReturnValue(true)
    helpRoute({ engine: "claude", model: "haiku", effort: "low" })
    mocks.fetchAuthAction.mockResolvedValue({
      profile: "grounded-help",
      phase: "help-answer",
      userPromptTemplate: AGENTS["help-assistant"].defaultUserPromptTemplate,
      brandVoice: null,
    })
    mocks.fetchAuthMutation.mockResolvedValue(null)
    mocks.generate.mockResolvedValue({
      text: [
        "Open Pages, choose New page, then pick the AI drafting option.",
        "```json",
        '{"intent":"create-page"}',
        "```",
      ].join("\n"),
      output: "grounded help answer",
      selected: {
        lane: "local-build",
        engine: "claude-cli",
        model: "haiku",
        effort: "low",
      },
      actual: {
        engine: "claude-cli",
        model: "claude-haiku-4-5",
        effort: "low",
      },
      identityEvidence: "transcript-observed",
      attempts: 1,
      usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      finishReason: "stop",
    })
    mocks.createEngine.mockReturnValue({
      id: "claude",
      generate: mocks.generate,
    })
  })

  test("starts the system prompt with the saved Instructions", async () => {
    const saved = "Answer in one short paragraph. Never mention pricing."
    mocks.fetchAuthAction.mockResolvedValue({
      profile: "grounded-help",
      phase: "help-answer",
      userPromptTemplate: AGENTS["help-assistant"].defaultUserPromptTemplate,
      brandVoice: null,
      assistantInstructions: saved,
    })

    await answerHelpQuestion({
      question: "How do I draft content?",
      route: "/admin/pages",
    })

    const request = mocks.generate.mock.calls[0]![0]
    expect(request.instructions.startsWith(`${saved}\n\n`)).toBe(true)
    expect(request.instructions).toContain("/admin/pages")
  })

  test("answers from the real grounded context through the exact selected route without content writes", async () => {
    const question = "How do I draft content?"

    await expect(
      answerHelpQuestion({ question, route: "/admin/pages" })
    ).resolves.toEqual({
      answer: "Open Pages, choose New page, then pick the AI drafting option.",
      sources: [
        "Draft a page with AI",
        "Publish a page",
      ],
      suggestedAction: {
        id: "create-page",
        label: "Create a new page",
        href: "/admin/pages/new",
      },
    })

    expect(mocks.readDevAiSelection).toHaveBeenCalledOnce()
    expect(mocks.resolveDevAiTaskSelection).not.toHaveBeenCalled()
    expect(mocks.fetchAuthAction).toHaveBeenCalledOnce()
    expect(getFunctionName(mocks.fetchAuthAction.mock.calls[0]![0])).toBe(
      "agents/localGeneration:preflight"
    )
    expect(mocks.fetchAuthAction).toHaveBeenCalledWith(expect.anything(), {
      kind: "help-answer",
    })
    expect(mocks.createEngine).toHaveBeenCalledWith("claude", {
      accounting: { admit: expect.any(Function), settle: expect.any(Function) },
      engineModel: "haiku",
      engineEffort: "low",
    })
    expect(mocks.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        instructions: expect.stringContaining("/admin/pages"),
        prompt: expect.stringContaining(question),
        images: [],
        profile: "grounded-help",
        phase: "help-answer",
      })
    )
    const generationRequest = mocks.generate.mock.calls[0]?.[0]
    expect(generationRequest.prompt).toContain("Create and edit a page")
    expect(generationRequest.prompt).toContain(
      "Block types currently available"
    )

    expect(mocks.fetchAuthMutation).toHaveBeenCalledOnce()
    expect(getFunctionName(mocks.fetchAuthMutation.mock.calls[0]![0])).toBe(
      "agents/localGeneration:recordAudit"
    )
    expect(mocks.fetchAuthMutation).toHaveBeenCalledWith(expect.anything(), {
      authId: "owner-auth",
      authorizedAt: expect.any(Number),
      attemptId: expect.any(String),
      kind: "help-answer",
      selectedEngine: "claude-cli",
      funding: "plan",
      selectedModel: "haiku",
      selectedReasoning: "low",
      actualEngine: "claude-cli",
      actualModel: "claude-haiku-4-5",
      actualReasoning: "low",
      identityEvidence: "transcript-observed",
      attempts: 1,
      tokenUsage: {
        promptTokens: 80,
        completionTokens: 20,
        totalTokens: 100,
      },
      success: true,
    })
    const audit = JSON.stringify(mocks.fetchAuthMutation.mock.calls[0]?.[1])
    expect(audit).not.toContain(question)
    expect(audit).not.toContain("Open Pages")
    expect(audit).not.toContain("Block types currently available")
    expect(audit).not.toContain("server-only")
  })

  test("rethrows selected-local failure without calling Production", async () => {
    const selectedRouteFailure = Object.assign(
      new Error("selected local help failed"),
      {
        category: "TIMEOUT",
        selected: {
          lane: "local-build",
          engine: "claude-cli",
          model: "haiku",
          effort: "low",
        },
        attempts: 1,
      }
    )
    mocks.generate.mockRejectedValue(selectedRouteFailure)
    mocks.fetchAuthMutation.mockRejectedValue(new Error("audit unavailable"))

    await expect(
      answerHelpQuestion({
        question: "How do I draft content?",
        route: "/admin/pages",
      })
    ).rejects.toBe(selectedRouteFailure)

    expect(mocks.fetchAuthAction).toHaveBeenCalledOnce()
    expect(getFunctionName(mocks.fetchAuthAction.mock.calls[0]![0])).toBe(
      "agents/localGeneration:preflight"
    )
    expect(mocks.createEngine).toHaveBeenCalledOnce()
    expect(mocks.fetchAuthMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: "help-answer",
        selectedEngine: "claude-cli",
        funding: "plan",
        selectedModel: "haiku",
        selectedReasoning: "low",
        attempts: 1,
        success: false,
        errorCode: "TIMEOUT",
      })
    )
  })

  test("delegates directly to Production only when grounded help is explicitly Off", async () => {
    helpRoute({ engine: "off" })
    const productionAnswer = {
      answer: "Production help answer",
      sources: ["Site settings"],
    }
    mocks.fetchAuthAction.mockResolvedValue(productionAnswer)
    const args = {
      question: "Where are the settings?",
      route: "/admin/settings",
    }

    await expect(answerHelpQuestion(args)).resolves.toBe(productionAnswer)

    expect(mocks.fetchAuthAction).toHaveBeenCalledOnce()
    expect(getFunctionName(mocks.fetchAuthAction.mock.calls[0]![0])).toBe(
      "agents/helpAssistant:answer"
    )
    expect(mocks.fetchAuthAction).toHaveBeenCalledWith(expect.anything(), args)
    expect(mocks.createEngine).not.toHaveBeenCalled()
    expect(mocks.fetchAuthMutation).not.toHaveBeenCalled()
  })

  test("fails closed when the engine reports a different selected tuple", async () => {
    mocks.generate.mockResolvedValue({
      text: "Open Settings → AI.",
      output: "mismatched help answer",
      selected: {
        lane: "local-build",
        engine: "claude-cli",
        model: "sonnet",
        effort: "medium",
      },
      actual: {
        engine: "claude-cli",
        model: "claude-sonnet-4-6",
        effort: "medium",
      },
      identityEvidence: "transcript-observed",
      attempts: 1,
      usage: {},
      finishReason: "stop",
    })

    await expect(
      answerHelpQuestion({
        question: "How do I configure AI?",
        route: "/admin/settings/ai",
      })
    ).rejects.toThrow(/different selected model identity/i)

    expect(mocks.fetchAuthAction).toHaveBeenCalledOnce()
    expect(getFunctionName(mocks.fetchAuthAction.mock.calls[0]![0])).toBe(
      "agents/localGeneration:preflight"
    )
    expect(mocks.fetchAuthMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: "help-answer",
        selectedEngine: "claude-cli",
        funding: "plan",
        selectedModel: "haiku",
        selectedReasoning: "low",
        attempts: 1,
        success: false,
        errorCode: "VALIDATION_FAILED",
      })
    )
  })

  test("fails closed on invalid help output and audits the generation without private text", async () => {
    mocks.generate.mockResolvedValue({
      text: "   ",
      output: "empty help answer",
      selected: {
        lane: "local-build",
        engine: "claude-cli",
        model: "haiku",
        effort: "low",
      },
      actual: {
        engine: "claude-cli",
        model: "claude-haiku-4-5",
        effort: "low",
      },
      identityEvidence: "transcript-observed",
      attempts: 1,
      usage: { inputTokens: 40, outputTokens: 0, totalTokens: 40 },
      finishReason: "stop",
    })

    await expect(
      answerHelpQuestion({
        question: "Tell me private customer details",
        route: "/admin/pages",
      })
    ).rejects.toThrow(/empty/i)

    expect(mocks.fetchAuthMutation).toHaveBeenCalledOnce()
    expect(mocks.fetchAuthMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: "help-answer",
        selectedEngine: "claude-cli",
        funding: "plan",
        selectedModel: "haiku",
        selectedReasoning: "low",
        attempts: 1,
        success: false,
        errorCode: "INVALID_OUTPUT",
      })
    )
    expect(
      JSON.stringify(mocks.fetchAuthMutation.mock.calls[0]?.[1])
    ).not.toContain("private customer")
  })

  test("rejects caller-supplied identity and invalid bounds before routing work", async () => {
    await expect(
      answerHelpQuestion({
        question: "How do I draft content?",
        route: "/admin/pages",
        authId: "caller-controlled",
      } as unknown as Parameters<typeof answerHelpQuestion>[0])
    ).rejects.toThrow(/unexpected help input field/i)
    await expect(
      answerHelpQuestion({ question: "x".repeat(2_001) })
    ).rejects.toThrow(/too long/i)

    expect(mocks.isLocalDevelopment).not.toHaveBeenCalled()
    expect(mocks.readDevAiSelection).not.toHaveBeenCalled()
    expect(mocks.resolveDevAiTaskSelection).not.toHaveBeenCalled()
    expect(mocks.fetchAuthAction).not.toHaveBeenCalled()
    expect(mocks.createEngine).not.toHaveBeenCalled()
    expect(mocks.fetchAuthMutation).not.toHaveBeenCalled()
  })
})

describe("answerHelpQuestion local tool route from another device", () => {
  const ARGS = { question: "How do I draft content?", route: "/admin/pages" }
  const PAST_ROUTE_CHECK = new Error("reached preflight")

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isLocalDevelopment.mockReturnValue(true)
    mocks.fetchAuthAction.mockRejectedValue(PAST_ROUTE_CHECK)
    mocks.createEngine.mockReturnValue({ id: "fake", generate: mocks.generate })
  })

  for (const engine of ["claude", "codex"] as const) {
    test(`refuses ${engine} from another device and never calls Convex Help`, async () => {
      mocks.isLocalToolRequest.mockResolvedValue(false)
      helpRoute({ engine, model: "default", effort: "low" })

      await expect(answerHelpQuestion(ARGS)).rejects.toThrow(
        LOCAL_TOOL_REFUSED_MESSAGE
      )
      expect(mocks.createEngine).not.toHaveBeenCalled()
      expect(mocks.generate).not.toHaveBeenCalled()
      expect(mocks.fetchAuthAction).not.toHaveBeenCalled()
      expect(mocks.fetchAuthMutation).not.toHaveBeenCalled()
    })

    test(`passes the route check for ${engine} on this computer`, async () => {
      mocks.isLocalToolRequest.mockResolvedValue(true)
      helpRoute({ engine, model: "default", effort: "low" })

      await expect(answerHelpQuestion(ARGS)).rejects.toBe(PAST_ROUTE_CHECK)
    })
  }

  test("an API engine in the local file never runs Help locally: the live-site route answers", async () => {
    mocks.isLocalToolRequest.mockResolvedValue(true)
    helpRoute({ engine: "anthropic" })

    await expect(answerHelpQuestion(ARGS)).rejects.toBe(PAST_ROUTE_CHECK)
    expect(getFunctionName(mocks.fetchAuthAction.mock.calls[0]![0])).toBe(
      "agents/helpAssistant:answer"
    )
    expect(mocks.createEngine).not.toHaveBeenCalled()
  })

  test("from another device Help is refused without reading the local file, whatever it holds", async () => {
    mocks.isLocalToolRequest.mockResolvedValue(false)
    helpRoute({ engine: "anthropic" })

    await expect(answerHelpQuestion(ARGS)).rejects.toThrow(
      LOCAL_TOOL_REFUSED_MESSAGE
    )
    expect(mocks.readDevAiSelection).not.toHaveBeenCalled()
    expect(mocks.fetchAuthAction).not.toHaveBeenCalled()
  })

  test("the file's top-level local tool never runs Help", async () => {
    mocks.isLocalToolRequest.mockResolvedValue(true)
    mocks.readDevAiSelection.mockReturnValue({ version: 3, engine: "claude" })

    await expect(answerHelpQuestion(ARGS)).rejects.toBe(PAST_ROUTE_CHECK)
    expect(getFunctionName(mocks.fetchAuthAction.mock.calls[0]![0])).toBe(
      "agents/helpAssistant:answer"
    )
    expect(mocks.createEngine).not.toHaveBeenCalled()
  })

  test.each([
    ["answerHelpQuestion", () => answerHelpQuestion(ARGS)],
    ["askHelp", () => askHelp(ARGS)],
  ])("%s: anyone but the owner reads nothing and calls no AI", async (_name, run) => {
    mocks.requireInstallationOwner.mockRejectedValueOnce(new Error("owner only"))
    mocks.isLocalToolRequest.mockResolvedValue(true)
    helpRoute({ engine: "claude", model: "haiku", effort: "low" })

    await run().catch(() => undefined)
    expect(mocks.isLocalToolRequest).not.toHaveBeenCalled()
    expect(mocks.readDevAiSelection).not.toHaveBeenCalled()
    expect(mocks.createEngine).not.toHaveBeenCalled()
    expect(mocks.fetchAuthAction).not.toHaveBeenCalled()
    expect(mocks.fetchAuthMutation).not.toHaveBeenCalled()
  })
})

describe("askHelp (the Help chat's call in local development)", () => {
  const ARGS = { question: "How do I draft content?", route: "/admin/pages" }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isLocalDevelopment.mockReturnValue(true)
    mocks.isLocalToolRequest.mockResolvedValue(true)
    helpRoute({ engine: "claude", model: "haiku", effort: "low" })
    mocks.createEngine.mockReturnValue({ id: "claude", generate: mocks.generate })
  })

  test("returns the answer of the local tool", async () => {
    mocks.fetchAuthAction.mockResolvedValue({
      profile: "grounded-help",
      phase: "help-answer",
      userPromptTemplate: AGENTS["help-assistant"].defaultUserPromptTemplate,
      brandVoice: null,
    })
    mocks.generate.mockResolvedValue({
      text: 'Open Pages.\n```json\n{"intent":"open-pages"}\n```',
      output: "",
      selected: { lane: "local-build", engine: "claude-cli", model: "haiku", effort: "low" },
      actual: { engine: "claude-cli", model: "claude-haiku-4-5", effort: "low" },
      identityEvidence: "transcript-observed",
      attempts: 1,
      usage: {},
      finishReason: "stop",
    })

    const outcome = await askHelp(ARGS)
    expect(outcome).toMatchObject({ ok: true, answer: { answer: "Open Pages." } })
    expect(mocks.createEngine).toHaveBeenCalledOnce()
  })

  test("a refused tool comes back as needing setup, never as an API answer", async () => {
    mocks.isLocalToolRequest.mockResolvedValue(false)
    await expect(askHelp(ARGS)).resolves.toEqual({
      ok: false,
      category: "CONFIG_MISSING",
      localTool: true,
    })
    expect(mocks.fetchAuthAction).not.toHaveBeenCalled()
  })

  test("with no local tool chosen, Help's API service answers through Convex at submit time", async () => {
    helpRoute({ engine: "off" })
    const answer = { answer: "From the live route.", sources: [] }
    mocks.fetchAuthAction.mockResolvedValue(answer)

    await expect(askHelp(ARGS)).resolves.toEqual({ ok: true, answer })
    expect(getFunctionName(mocks.fetchAuthAction.mock.calls[0]![0])).toBe(
      "agents/helpAssistant:answer"
    )
    expect(mocks.createEngine).not.toHaveBeenCalled()
  })

  test("an API service failure keeps its category and says no local tool ran", async () => {
    helpRoute({ engine: "off" })
    mocks.fetchAuthAction.mockRejectedValue(
      new ConvexError({ category: "AUTH_REQUIRED" })
    )
    await expect(askHelp(ARGS)).resolves.toEqual({
      ok: false,
      category: "AUTH_REQUIRED",
      localTool: false,
    })
  })

  test.each([
    [Object.assign(new Error("x"), { category: "AUTH_REQUIRED" }), "AUTH_REQUIRED"],
    [new ConvexError({ kind: "RateLimited" }), "RATE_LIMITED"],
    [new ConvexError({ category: "QUOTA_EXHAUSTED" }), "QUOTA_EXHAUSTED"],
    [new Error("anything else"), "OTHER"],
  ])("keeps the failure category (%s)", async (error, category) => {
    mocks.fetchAuthAction.mockRejectedValue(error)
    await expect(askHelp(ARGS)).resolves.toEqual({
      ok: false,
      category,
      localTool: true,
    })
  })
})

// Guard (d): Help's audit after a long tool run is signed with the owner and
// time of the run's start and its own attempt identifier; no owner check runs
// after the run (the token may have expired).
describe("Help audit after the session token expired during the run", () => {
  const START = Date.UTC(2026, 10, 15, 12, 0, 0)
  const ARGS = { question: "How do I draft content?", route: "/admin/pages" }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ now: START, toFake: ["Date"] })
    mocks.requireInstallationOwner.mockResolvedValue({ authId: "owner-auth" })
    mocks.isLocalDevelopment.mockReturnValue(true)
    mocks.isLocalToolRequest.mockResolvedValue(true)
    helpRoute({ engine: "claude", model: "haiku", effort: "low" })
    mocks.fetchAuthAction.mockResolvedValue({
      profile: "grounded-help",
      phase: "help-answer",
      userPromptTemplate: AGENTS["help-assistant"].defaultUserPromptTemplate,
      brandVoice: null,
    })
    mocks.fetchAuthMutation.mockResolvedValue(null)
    mocks.createEngine.mockReturnValue({ id: "claude", generate: mocks.generate })
    mocks.generate.mockImplementation(async () => {
      vi.setSystemTime(START + 4 * 60_000)
      mocks.requireInstallationOwner.mockRejectedValue(new Error("expired"))
      return {
        text: 'Open Pages.\n```json\n{"intent":"open-pages"}\n```',
        output: "",
        selected: { lane: "local-build", engine: "claude-cli", model: "haiku", effort: "low" },
        actual: { engine: "claude-cli", model: "claude-haiku-4-5", effort: "low" },
        identityEvidence: "transcript-observed",
        attempts: 1,
        usage: {},
        finishReason: "stop",
      }
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    mocks.requireInstallationOwner.mockResolvedValue({ authId: "owner-auth" })
  })

  test("the answer comes back and the audit is recorded with the start-time authorization", async () => {
    await expect(askHelp(ARGS)).resolves.toMatchObject({ ok: true })
    expect(mocks.fetchAuthMutation).toHaveBeenCalledOnce()
    expect(mocks.fetchAuthMutation.mock.calls[0]![1]).toMatchObject({
      kind: "help-answer",
      selectedEngine: "claude-cli",
      authId: "owner-auth",
      authorizedAt: START,
      attemptId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
  })
})
