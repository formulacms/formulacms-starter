// @vitest-environment node
// A local tool run records how it was billed. This test uses the real funding
// lookup and the real sign-in status code; only the status command is replaced
// (injected at its seam), so no `claude` or `codex` command runs.
import { beforeEach, describe, expect, test, vi } from "vitest"
import { AGENTS } from "@/convex/lib/agents/registry"

const mocks = vi.hoisted(() => ({
  createEngine: vi.fn(),
  runCommand: vi.fn(),
  fetchAuthAction: vi.fn(),
  fetchAuthMutation: vi.fn(),
  generate: vi.fn(),
  toolEnv: {} as Record<string, string>,
}))

vi.mock("server-only", () => ({}))

// The owner check before any local effect, and the run-start authorization
// signed into the audit (`local-ai-audit.ts`).
vi.mock("@/lib/owner-server", () => ({
  requireInstallationOwner: vi.fn(async () => ({ authId: "owner-auth" })),
}))

vi.mock("@/scripts/lib/dev-ai-connections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/scripts/lib/dev-ai-connections")>()
  return {
    ...actual,
    inspectDevAiConnection: (...[choice, options]: Parameters<typeof actual.inspectDevAiConnection>) =>
      actual.inspectDevAiConnection(choice, { ...options, runCommand: mocks.runCommand }),
  }
})

vi.mock("@/scripts/lib/subscription-cli-process", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/scripts/lib/subscription-cli-process")
  >()),
  localToolEnvironment: () => mocks.toolEnv,
}))

vi.mock("@/lib/assert-local-dev", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assert-local-dev")>()),
  assertLocalDevelopment: vi.fn(),
  isLocalDevelopment: () => true,
}))

vi.mock("@/lib/local-request", () => ({ isLocalToolRequest: async () => true }))

vi.mock("@/lib/auth/server", () => ({
  fetchAuthAction: mocks.fetchAuthAction,
  fetchAuthMutation: mocks.fetchAuthMutation,
}))

vi.mock("@/scripts/lib/ai-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/scripts/lib/ai-engine")>()),
  createEngine: mocks.createEngine,
}))

// Help on Claude Code, as Settings › AI saves it.
vi.mock("@/scripts/lib/dev-ai-selection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/scripts/lib/dev-ai-selection")>()),
  readDevAiSelection: () => ({
    version: 3,
    engine: "openrouter",
    tasks: {
      "grounded-help": { engine: "claude", model: "haiku", effort: "low" },
    },
  }),
}))

vi.mock("@/convex/lib/localAiAuditProof", () => ({
  signLocalAiAudit: (event: unknown) => event,
}))

import { answerHelpQuestion } from "./help-ai-actions"
import { resetLocalToolFundingCache } from "@/lib/ai/local-tool-funding"

// `claude auth status` for a plan sign-in. The API key in the tool
// environment still wins (Claude Code authentication precedence).
const PLAN_STATUS = JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })

describe("local tool run audit funding", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLocalToolFundingCache()
    mocks.toolEnv = { PATH: "/usr/bin" }
    mocks.runCommand.mockResolvedValue({ exitCode: 0, stdout: PLAN_STATUS, stderr: "" })
    mocks.fetchAuthAction.mockResolvedValue({
      profile: "grounded-help",
      phase: "help-answer",
      userPromptTemplate: AGENTS["help-assistant"].defaultUserPromptTemplate,
      brandVoice: null,
    })
    mocks.fetchAuthMutation.mockResolvedValue(null)
    mocks.generate.mockResolvedValue({
      text: "Open Pages, then choose New page.",
      output: "answer",
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
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
      finishReason: "stop",
    })
    mocks.createEngine.mockReturnValue({
      id: "claude",
      generate: mocks.generate,
    })
  })

  const ask = () =>
    answerHelpQuestion({ question: "How do I add a page?", route: "/admin" })

  test("records api-key when the tool environment has ANTHROPIC_API_KEY", async () => {
    mocks.toolEnv = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "present" }
    await ask()
    expect(mocks.runCommand).toHaveBeenCalledOnce()
    // The status check runs in the tool's own environment, which holds the key.
    expect(mocks.runCommand.mock.calls[0]).toEqual([
      "claude",
      ["auth", "status"],
      { PATH: "/usr/bin", ANTHROPIC_API_KEY: "present" },
    ])
    expect(mocks.fetchAuthMutation).toHaveBeenCalledOnce()
    expect(mocks.fetchAuthMutation.mock.calls[0]?.[1]).toMatchObject({
      selectedEngine: "claude-cli",
      funding: "api-key",
    })
    // Only the sign-in method is kept: no vendor output, no key value.
    const audit = JSON.stringify(mocks.fetchAuthMutation.mock.calls[0]?.[1])
    expect(audit).not.toContain("present")
    expect(audit).not.toContain("claude.ai")
  })

  test("records plan for a plan sign-in", async () => {
    await ask()
    expect(mocks.fetchAuthMutation.mock.calls[0]?.[1]).toMatchObject({
      funding: "plan",
    })
  })

  test("records unknown when the status command cannot run", async () => {
    mocks.runCommand.mockResolvedValue({ exitCode: null, stdout: "", stderr: "", errorCode: "ENOENT" })
    await ask()
    expect(mocks.fetchAuthMutation.mock.calls[0]?.[1]).toMatchObject({
      funding: "unknown",
    })
  })
})
