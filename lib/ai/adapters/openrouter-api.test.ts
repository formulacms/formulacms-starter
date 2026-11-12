import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const chat = vi.fn((modelId: string, settings: unknown) => ({
    modelId,
    settings,
  }))
  return {
    chat,
    createOpenRouter: vi.fn(() => ({ chat })),
    generateText: vi.fn(),
  }
})

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: mocks.createOpenRouter,
}))

vi.mock("ai", () => ({
  generateText: mocks.generateText,
}))

import { taskProfileTuple } from "../task-profiles"
import { createOpenRouterGenerationAdapter } from "./openrouter-api"

describe("OpenRouter catalog adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.generateText.mockResolvedValue({
      text: "MODEL OUTPUT",
      finishReason: "stop",
      usage: {
        raw: { reported: true },
        inputTokens: 5,
        outputTokens: 3,
        totalTokens: 8,
        inputTokenDetails: {
          noCacheTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      finalStep: {
        response: { modelId: "openai/gpt-5.6-sol" },
        providerMetadata: { openrouter: { provider: "openai" } },
      },
    })
  })

  test("pins upstream routing, forwards explicit effort, and disables SDK retries", async () => {
    const adapter = createOpenRouterGenerationAdapter({
      apiKey: "unit-test-key",
      appName: "formulacms-test",
      appUrl: "https://example.test",
    })
    const signal = new AbortController().signal
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

    await expect(
      adapter.generate({
        tuple: taskProfileTuple("openrouter", "vision-spec"),
        instructions: "SYSTEM",
        input: { messages },
        abortSignal: signal,
        maxRetries: 0,
        maxOutputTokens: 8192,
      })
    ).resolves.toEqual({
      text: "MODEL OUTPUT",
      finishReason: "stop",
      usage: {
        inputTokens: 5,
        outputTokens: 3,
        totalTokens: 8,
        noCacheInputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      actualModel: "openai/gpt-5.6-sol",
      routedProvider: "openai",
    })

    expect(mocks.createOpenRouter).toHaveBeenCalledOnce()
    expect(mocks.chat).toHaveBeenCalledWith("openai/gpt-5.6-sol", {
      provider: {
        allow_fallbacks: false,
        require_parameters: true,
      },
      reasoning: { effort: "high" },
    })
    expect(mocks.generateText).toHaveBeenCalledWith({
      model: {
        modelId: "openai/gpt-5.6-sol",
        settings: {
          provider: {
            allow_fallbacks: false,
            require_parameters: true,
          },
          reasoning: { effort: "high" },
        },
      },
      instructions: "SYSTEM",
      system: undefined,
      messages,
      abortSignal: signal,
      maxRetries: 0,
      maxOutputTokens: 8192,
    })
  })
})
