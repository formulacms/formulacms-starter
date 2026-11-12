// @vitest-environment node
import { createTestAccounting } from "@/lib/ai/accounting.testFixtures"
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const chat = vi.fn((modelId: string, settings?: unknown) => ({
    modelId,
    settings,
  }))
  const messages = vi.fn((modelId: string) => ({
    modelId,
    provider: "anthropic",
  }))
  const responses = vi.fn((modelId: string) => ({
    modelId,
    provider: "openai",
  }))
  return {
    chat,
    messages,
    responses,
    createOpenRouter: vi.fn(() => ({ chat })),
    createAnthropic: vi.fn(() => ({ messages })),
    createOpenAI: vi.fn(() => ({ responses })),
    generateText: vi.fn(),
  }
})

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: mocks.createOpenRouter,
}))

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: mocks.createAnthropic,
}))

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: mocks.createOpenAI,
}))

vi.mock("ai", () => ({
  generateText: mocks.generateText,
}))

import {
  createRuntimeAnthropicAdapter,
  createRuntimeOpenAIAdapter,
  createRuntimeOpenRouterAdapter,
  generateRuntimeText,
} from "./ai"

function sdkResult(overrides: Record<string, unknown> = {}) {
  return {
    text: "MODEL OUTPUT",
    finishReason: "stop",
    usage: {
      raw: { reported: true },
      inputTokens: 2,
      outputTokens: 1,
      totalTokens: 3,
    },
    finalStep: {
      response: { modelId: "openai/gpt-test" },
      providerMetadata: { openrouter: { provider: "openai" } },
    },
    ...overrides,
  }
}

describe("runtime OpenRouter adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("OPENROUTER_API_KEY", "unit-test-key")
    vi.stubEnv("CMS_AI_MODEL", "")
    mocks.generateText.mockResolvedValue(sdkResult())
  })

  test("preserves headers and request shape while disabling SDK/upstream fallback", async () => {
    expect(createRuntimeOpenRouterAdapter()).toMatchObject({
      provider: "openrouter",
    })
    expect(mocks.createOpenRouter).toHaveBeenCalledWith({
      apiKey: "unit-test-key",
      appName: "formulacms",
      appUrl: "https://github.com/formulacms",
    })

    await expect(
      generateRuntimeText(
        "openrouter:openai/gpt-test",
        {
          profile: "editorial-copy",
          phase: "content-generation",
          instructions: "SYSTEM PROMPT",
          prompt: "USER PROMPT",
        },
        createTestAccounting()
      )
    ).resolves.toMatchObject({
      text: "MODEL OUTPUT",
      attempts: 1,
      selected: {
        lane: "runtime",
        provider: "openrouter",
        model: "openai/gpt-test",
      },
      actual: {
        provider: "openrouter",
        model: "openai/gpt-test",
        routedProvider: "openai",
      },
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    })

    expect(mocks.chat).toHaveBeenCalledWith("openai/gpt-test", {
      provider: {
        allow_fallbacks: false,
        require_parameters: true,
      },
    })
    expect(mocks.generateText).toHaveBeenCalledWith({
      model: {
        modelId: "openai/gpt-test",
        settings: {
          provider: {
            allow_fallbacks: false,
            require_parameters: true,
          },
        },
      },
      instructions: "SYSTEM PROMPT",
      system: undefined,
      prompt: "USER PROMPT",
      abortSignal: expect.any(AbortSignal),
      maxRetries: 0,
      maxOutputTokens: expect.any(Number),
    })
  })

  test("returns a safe normalized configuration error when the key is blank", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "   ")

    await expect(
      generateRuntimeText(
        "openai/gpt-test",
        {
          selectedProvider: "openrouter",
          profile: "editorial-copy",
          phase: "content-generation",
          prompt: "USER PROMPT",
        },
        createTestAccounting()
      )
    ).rejects.toMatchObject({
      data: {
        category: "CONFIG_MISSING",
        attempts: 0,
        retryable: false,
        nextAction: "configure-provider",
      },
    })
    expect(mocks.generateText).not.toHaveBeenCalled()
  })

  test("uses a typed agent override before a typed site default", async () => {
    const site = {
      mode: "catalog",
      provider: "openrouter",
      model: "openai/gpt-5.6-terra",
      reasoning: { kind: "effort", effort: "high" },
    } as const
    const agent = {
      mode: "catalog",
      provider: "openrouter",
      model: "google/gemini-3.5-flash",
      reasoning: { kind: "effort", effort: "high" },
    } as const
    const result = await generateRuntimeText(
      "legacy/ignored",
      {
        selectedProvider: "openrouter",
        providerDefaults: { openrouter: site },
        modelOverrides: { openrouter: agent },
        profile: "editorial-copy",
        phase: "content-generation",
        prompt: "USER PROMPT",
      },
      createTestAccounting()
    )
    expect(result.selected).toMatchObject({
      provider: "openrouter",
      model: "google/gemini-3.5-flash",
      effort: "high",
    })
    expect(mocks.chat).toHaveBeenCalledWith(
      "google/gemini-3.5-flash",
      expect.any(Object)
    )
  })
})

describe("direct runtime provider composition", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("OPENROUTER_API_KEY", "")
    vi.stubEnv("ANTHROPIC_API_KEY", "")
    vi.stubEnv("OPENAI_API_KEY", "")
    vi.stubEnv("CMS_AI_MODEL", "")
  })

  // The `vision-spec` profile below is now a build-lane-only entry in the
  // shared `TASK_PROFILES` contract (the 2026-07-14 ADR-0032 amendment moved
  // slice authoring off the runtime lane). It still exercises the generic
  // `generateRuntimeText` executor's image handling here — no runtime caller
  // reaches this codepath — and stays as the only committed runtime tuple
  // that declares image input for the unit-level test.
  test("executes the selected Anthropic image tuple without switching providers", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-unit-test-key")
    vi.stubEnv("OPENAI_API_KEY", "openai-present-but-unselected")
    mocks.generateText.mockResolvedValue(
      sdkResult({
        finalStep: { response: { modelId: "claude-sonnet-5-5" } },
      })
    )
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "PROMPT" },
          {
            type: "file" as const,
            data: "data:image/png;base64,AAAA",
            mediaType: "image/png",
          },
        ],
      },
    ]

    expect(createRuntimeAnthropicAdapter()).toMatchObject({
      provider: "anthropic",
    })
    await expect(
      generateRuntimeText(
        undefined,
        {
          selectedProvider: "anthropic",
          profile: "vision-spec",
          phase: "slice-spec",
          instructions: "SYSTEM PROMPT",
          messages,
        },
        createTestAccounting()
      )
    ).resolves.toMatchObject({
      text: "MODEL OUTPUT",
      attempts: 1,
      selected: {
        lane: "runtime",
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        effort: "high",
      },
      actual: {
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        effort: "high",
      },
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    })

    expect(mocks.createAnthropic).toHaveBeenCalledWith({
      apiKey: "anthropic-unit-test-key",
    })
    expect(mocks.messages).toHaveBeenCalledWith("claude-sonnet-5-5")
    expect(mocks.createOpenAI).not.toHaveBeenCalled()
    expect(mocks.generateText).toHaveBeenCalledWith({
      model: { modelId: "claude-sonnet-5-5", provider: "anthropic" },
      instructions: "SYSTEM PROMPT",
      system: undefined,
      messages,
      providerOptions: { anthropic: { effort: "high" } },
      abortSignal: expect.any(AbortSignal),
      maxRetries: 0,
      maxOutputTokens: expect.any(Number),
    })
  })

  test("executes the selected OpenAI text tuple without switching providers", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-present-but-unselected")
    vi.stubEnv("OPENAI_API_KEY", "openai-unit-test-key")
    mocks.generateText.mockResolvedValue(
      sdkResult({
        finalStep: { response: { modelId: "gpt-6.1-terra" } },
      })
    )

    expect(createRuntimeOpenAIAdapter()).toMatchObject({ provider: "openai" })
    await expect(
      generateRuntimeText(
        undefined,
        {
          selectedProvider: "openai",
          profile: "structured-outline-meta",
          phase: "page-outline",
          instructions: "SYSTEM PROMPT",
          prompt: "USER PROMPT",
        },
        createTestAccounting()
      )
    ).resolves.toMatchObject({
      text: "MODEL OUTPUT",
      attempts: 1,
      selected: {
        lane: "runtime",
        provider: "openai",
        model: "gpt-6.1-terra",
        effort: "medium",
      },
      actual: {
        provider: "openai",
        model: "gpt-6.1-terra",
        effort: "medium",
      },
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    })

    expect(mocks.createOpenAI).toHaveBeenCalledWith({
      apiKey: "openai-unit-test-key",
    })
    expect(mocks.responses).toHaveBeenCalledWith("gpt-6.1-terra")
    expect(mocks.createAnthropic).not.toHaveBeenCalled()
    expect(mocks.generateText).toHaveBeenCalledWith({
      model: { modelId: "gpt-6.1-terra", provider: "openai" },
      instructions: "SYSTEM PROMPT",
      system: undefined,
      prompt: "USER PROMPT",
      providerOptions: { openai: { reasoningEffort: "medium" } },
      abortSignal: expect.any(AbortSignal),
      maxRetries: 0,
      maxOutputTokens: expect.any(Number),
    })
  })

  test.each(["anthropic", "openai"] as const)(
    "fails closed when the selected %s credential is absent",
    async (selectedProvider) => {
      vi.stubEnv("OPENROUTER_API_KEY", "available-but-unselected")

      await expect(
        generateRuntimeText(
          undefined,
          {
            selectedProvider,
            profile: "editorial-copy",
            phase: "content-generation",
            prompt: "USER PROMPT",
          },
          createTestAccounting()
        )
      ).rejects.toMatchObject({
        data: {
          category: "CONFIG_MISSING",
          selected: { provider: selectedProvider },
          attempts: 0,
          retryable: false,
          nextAction: "configure-provider",
        },
      })
      expect(mocks.generateText).not.toHaveBeenCalled()
      expect(mocks.createOpenRouter).not.toHaveBeenCalled()
    }
  )

  test("normalizes a direct-provider auth failure without trying another configured provider", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-unit-test-key")
    vi.stubEnv("OPENAI_API_KEY", "openai-present-but-unselected")
    mocks.generateText.mockRejectedValue({ statusCode: 401 })

    await expect(
      generateRuntimeText(
        undefined,
        {
          selectedProvider: "anthropic",
          profile: "editorial-copy",
          phase: "content-generation",
          prompt: "USER PROMPT",
        },
        createTestAccounting()
      )
    ).rejects.toMatchObject({
      data: {
        category: "AUTH_REQUIRED",
        selected: { provider: "anthropic", model: "claude-sonnet-5-5" },
        attempts: 1,
        retryable: false,
      },
    })
    expect(mocks.generateText).toHaveBeenCalledOnce()
    expect(mocks.createAnthropic).toHaveBeenCalledOnce()
    expect(mocks.createOpenAI).not.toHaveBeenCalled()
    expect(mocks.createOpenRouter).not.toHaveBeenCalled()
  })
})

test("S2b explicit tuple never falls back when it cannot serve the requested profile", async () => {
  vi.clearAllMocks()
  vi.stubEnv("OPENAI_API_KEY", "fake-explicit-key")
  mocks.generateText.mockResolvedValue(sdkResult())
  const accounting = createTestAccounting()
  const { taskProfileTuple } = await import("../../lib/ai/task-profiles")
  await expect(
    generateRuntimeText(
      undefined,
      {
        selectedProvider: "openai",
        assistant: {
          provider: "openai",
          tuple: taskProfileTuple("openai", "editorial-copy") as Exclude<
            ReturnType<typeof taskProfileTuple>,
            { mode: "legacy" }
          >,
          legacy: false,
          instructions: "",
        },
        profile: "mechanical-translation",
        phase: "translation",
        prompt: "Translate this.",
      },
      accounting
    )
  ).rejects.toMatchObject({
    data: expect.objectContaining({
      category: "UNSUPPORTED_CAPABILITY",
      attempts: 0,
    }),
  })
  expect(mocks.generateText).not.toHaveBeenCalled()
  vi.unstubAllEnvs()
})


test("S2b legacy off has no runtime veto", async () => {
  vi.clearAllMocks()
  vi.stubEnv("OPENAI_API_KEY", "fake-off-key")
  vi.stubEnv("ANTHROPIC_API_KEY", "")
  vi.stubEnv("OPENROUTER_API_KEY", "")
  mocks.generateText.mockResolvedValue(sdkResult())
  await expect(generateRuntimeText(undefined, { selectedProvider: "off", profile: "editorial-copy", phase: "content-generation", prompt: "Write clearly." }, createTestAccounting())).resolves.toMatchObject({ selected: { provider: "openai" }, attempts: 1 })
  expect(mocks.generateText).toHaveBeenCalledOnce()
  vi.unstubAllEnvs()
})

// Fresh assistant profiles share one default, while non-assistant callers keep theirs.
test.each(["anthropic", "openrouter", "openai"] as const)(
  "S3 seam b: every %s assistant profile uses one valid default",
  async (provider) => {
    const { ASSISTANT_PROFILES, taskProfileTuple, validateTupleForProfiles } =
      await import("../../lib/ai/task-profiles")
    const { resolveAssistantRuntimeTuple } = await import("./ai")
    for (const profiles of Object.values(ASSISTANT_PROFILES)) {
      const primary = taskProfileTuple(provider, profiles[0])
      for (const profile of profiles) {
        const tuple = resolveAssistantRuntimeTuple(
          { provider, tuple: null, legacy: false, instructions: "" },
          { profile, phase: "content-generation" }
        )
        expect(tuple, `${provider}/${profile}`).toEqual(primary)
        expect(() => validateTupleForProfiles(tuple, profiles)).not.toThrow()
      }
    }
  }
)
