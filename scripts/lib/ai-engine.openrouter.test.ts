// @vitest-environment node
import { createTestAccounting } from "@/lib/ai/accounting.testFixtures"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const chat = vi.fn((modelId: string) => ({ modelId }))
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

// The engine reads .env.local at each call; here the reader maps the stubbed
// environment instead, so no test reads a real .env.local.
vi.mock("@/lib/local-api-keys-file", async () => {
  const { localApiKeysFrom } = await import("@/lib/local-api-keys")
  return { readLocalApiKeys: () => localApiKeysFrom(process.env) }
})

import { createEngine, type GenerateRequest } from "./ai-engine"

describe("build OpenRouter engine", () => {
  let fixtureDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.stubEnv("OPENROUTER_API_KEY", "runtime-key-must-be-ignored")
    vi.stubEnv("NEXTCMS_DEV_OPENROUTER_API_KEY", "unit-test-key")
    fixtureDir = await mkdtemp(join(tmpdir(), "formulacms-openrouter-test-"))
  })

  afterEach(async () => {
    await rm(fixtureDir, { recursive: true, force: true })
  })

  test("preserves provider headers, resolved model, prompt, and inline image", async () => {
    const imagePath = join(fixtureDir, "snapshot.png")
    await writeFile(imagePath, "PNG")
    mocks.generateText.mockResolvedValue({
      text: "MODEL OUTPUT",
      finishReason: "stop",
      usage: {
        raw: { reported: true },
        inputTokens: 2,
        outputTokens: 1,
        totalTokens: 3,
      },
      finalStep: {
        response: { modelId: "openai/gpt-6.1-sol" },
        providerMetadata: { openrouter: { provider: "openai" } },
      },
    })
    const request: GenerateRequest = {
      instructions: "SYSTEM PROMPT",
      prompt: "USER PROMPT",
      images: [{ path: imagePath, mediaType: "image/png" }],
      profile: "vision-spec",
      phase: "block-spec",
    }

    await expect(
      createEngine("openrouter", {
        accounting: createTestAccounting(),
      }).generate(request)
    ).resolves.toMatchObject({
      text: "MODEL OUTPUT",
      attempts: 1,
      selected: {
        lane: "local-build",
        provider: "openrouter",
        engine: "openrouter-api",
        model: "openai/gpt-6.1-sol",
        effort: "high",
      },
      actual: {
        provider: "openrouter",
        engine: "openrouter-api",
        model: "openai/gpt-6.1-sol",
        effort: "high",
        routedProvider: "openai",
      },
    })

    expect(mocks.createOpenRouter).toHaveBeenCalledWith({
      apiKey: "unit-test-key",
      appName: "formulacms-cli",
      appUrl: "https://github.com/formulacms",
    })
    expect(mocks.chat).toHaveBeenCalledWith("openai/gpt-6.1-sol", {
      provider: {
        allow_fallbacks: false,
        require_parameters: true,
      },
      reasoning: { effort: "high" },
    })
    expect(mocks.generateText).toHaveBeenCalledWith({
      model: { modelId: "openai/gpt-6.1-sol" },
      instructions: "SYSTEM PROMPT",
      system: undefined,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "USER PROMPT" },
            {
              type: "file",
              data: "data:image/png;base64,UE5H",
              mediaType: "image/png",
            },
          ],
        },
      ],
      abortSignal: expect.any(AbortSignal),
      maxRetries: 0,
      maxOutputTokens: expect.any(Number),
    })
  })

  test("preserves the existing no-key error", async () => {
    vi.stubEnv("NEXTCMS_DEV_OPENROUTER_API_KEY", "")

    await expect(
      createEngine("openrouter", {
        accounting: createTestAccounting(),
      }).generate({
        instructions: "SYSTEM PROMPT",
        prompt: "USER PROMPT",
        images: [],
        profile: "vision-spec",
        phase: "block-spec",
      })
    ).rejects.toMatchObject({
      category: "CONFIG_MISSING",
      attempts: 0,
      retryable: false,
      nextAction: "configure-provider",
    })
  })

  test("rejects an inline image above the existing 950k transport cap before billing", async () => {
    const imagePath = join(fixtureDir, "oversized.png")
    await writeFile(imagePath, "X".repeat(712_500))

    await expect(
      createEngine("openrouter", {
        accounting: createTestAccounting(),
      }).generate({
        instructions: "SYSTEM PROMPT",
        prompt: "USER PROMPT",
        images: [{ path: imagePath, mediaType: "image/png" }],
        profile: "vision-spec",
        phase: "block-spec",
      })
    ).rejects.toMatchObject({
      category: "INPUT_TOO_LARGE",
      attempts: 0,
      retryable: false,
    })
    expect(mocks.createOpenRouter).not.toHaveBeenCalled()
    expect(mocks.generateText).not.toHaveBeenCalled()
  })
})
