import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const messages = vi.fn((modelId: string) => ({ modelId }))
  return {
    messages,
    createAnthropic: vi.fn(() => ({ messages })),
    generateText: vi.fn(),
  }
})

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: mocks.createAnthropic,
}))

vi.mock("ai", () => ({
  generateText: mocks.generateText,
}))

import { taskProfileTuple } from "../task-profiles"
import { createAnthropicGenerationAdapter } from "./anthropic-api"

describe("Anthropic catalog adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.generateText.mockResolvedValue({
      text: "MODEL OUTPUT",
      finishReason: "stop",
      usage: {
        raw: { reported: true },
        inputTokens: 7,
        outputTokens: 4,
        totalTokens: 11,
        inputTokenDetails: {
          noCacheTokens: 7,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      finalStep: { response: { modelId: "claude-sonnet-5-5" } },
    })
  })

  test("forwards multimodal input, effort, usage, identity, cancellation, and the shared retry budget", async () => {
    const adapter = createAnthropicGenerationAdapter({
      apiKey: "unit-test-key",
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
        tuple: taskProfileTuple("anthropic", "vision-spec"),
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
        inputTokens: 7,
        outputTokens: 4,
        totalTokens: 11,
        noCacheInputTokens: 7,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      actualModel: "claude-sonnet-5-5",
    })

    expect(mocks.createAnthropic).toHaveBeenCalledWith({
      apiKey: "unit-test-key",
    })
    expect(mocks.messages).toHaveBeenCalledWith("claude-sonnet-5-5")
    expect(mocks.generateText).toHaveBeenCalledWith({
      model: { modelId: "claude-sonnet-5-5" },
      instructions: "SYSTEM",
      system: undefined,
      messages,
      providerOptions: { anthropic: { effort: "high" } },
      abortSignal: signal,
      maxRetries: 0,
      maxOutputTokens: 8192,
    })
  })

  test("omits provider options for the effort-free Haiku catalog tuple", async () => {
    const adapter = createAnthropicGenerationAdapter({
      apiKey: "unit-test-key",
    })

    await adapter.generate({
      tuple: { mode: "catalog", provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      instructions: "SYSTEM",
      input: { prompt: "PROMPT" },
      abortSignal: new AbortController().signal,
      maxRetries: 0,
      maxOutputTokens: 8192,
    })

    expect(mocks.messages).toHaveBeenCalledWith("claude-haiku-4-5-20251001")
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "PROMPT",
        providerOptions: undefined,
        maxRetries: 0,
        maxOutputTokens: 8192,
      })
    )
  })

  test("rejects a tuple for another provider before an SDK call", async () => {
    const adapter = createAnthropicGenerationAdapter({
      apiKey: "unit-test-key",
    })

    await expect(
      adapter.generate({
        tuple: taskProfileTuple("openai", "editorial-copy"),
        input: { prompt: "PROMPT" },
        abortSignal: new AbortController().signal,
        maxRetries: 0,
        maxOutputTokens: 8192,
      })
    ).rejects.toThrow("different provider tuple")
    expect(mocks.generateText).not.toHaveBeenCalled()
  })
})
