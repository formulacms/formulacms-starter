import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const responses = vi.fn((modelId: string) => ({ modelId }))
  return {
    responses,
    createOpenAI: vi.fn(() => ({ responses })),
    generateText: vi.fn(),
  }
})

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: mocks.createOpenAI,
}))

vi.mock("ai", () => ({
  generateText: mocks.generateText,
}))

import { taskProfileTuple } from "../task-profiles"
import { createOpenAIGenerationAdapter } from "./openai-api"

describe("OpenAI catalog adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.generateText.mockResolvedValue({
      text: "MODEL OUTPUT",
      finishReason: "stop",
      usage: {
        raw: { reported: true },
        inputTokens: 9,
        outputTokens: 5,
        totalTokens: 14,
        inputTokenDetails: {
          noCacheTokens: 9,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      },
      finalStep: { response: { modelId: "gpt-6.1-sol" } },
    })
  })

  test("forwards multimodal input, effort, usage, identity, cancellation, and the shared retry budget", async () => {
    const adapter = createOpenAIGenerationAdapter({ apiKey: "unit-test-key" })
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
        tuple: taskProfileTuple("openai", "vision-spec"),
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
        inputTokens: 9,
        outputTokens: 5,
        totalTokens: 14,
        noCacheInputTokens: 9,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      actualModel: "gpt-6.1-sol",
    })

    expect(mocks.createOpenAI).toHaveBeenCalledWith({ apiKey: "unit-test-key" })
    expect(mocks.responses).toHaveBeenCalledWith("gpt-6.1-sol")
    expect(mocks.generateText).toHaveBeenCalledWith({
      model: { modelId: "gpt-6.1-sol" },
      instructions: "SYSTEM",
      system: undefined,
      messages,
      providerOptions: { openai: { reasoningEffort: "high" } },
      abortSignal: signal,
      maxRetries: 0,
      maxOutputTokens: 8192,
    })
  })

  test("rejects a tuple for another provider before an SDK call", async () => {
    const adapter = createOpenAIGenerationAdapter({ apiKey: "unit-test-key" })

    await expect(
      adapter.generate({
        tuple: taskProfileTuple("anthropic", "editorial-copy"),
        input: { prompt: "PROMPT" },
        abortSignal: new AbortController().signal,
        maxRetries: 0,
        maxOutputTokens: 8192,
      })
    ).rejects.toThrow("different provider tuple")
    expect(mocks.generateText).not.toHaveBeenCalled()
  })
})
