// @vitest-environment node
import { createTestAccounting } from "@/lib/ai/accounting.testFixtures"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const chat = vi.fn((modelId: string, settings: unknown) => ({
    modelId,
    provider: "openrouter",
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
vi.mock("ai", () => ({ generateText: mocks.generateText }))
// The engine reads .env.local at each call; here the reader maps the stubbed
// environment instead, so no test reads a real .env.local.
vi.mock("@/lib/local-api-keys-file", async () => {
  const { localApiKeysFrom } = await import("@/lib/local-api-keys")
  return { readLocalApiKeys: () => localApiKeysFrom(process.env) }
})

import { createEngine, type EngineId, type GenerateRequest } from "./ai-engine"

const API_CASES = [
  ["openrouter", "openai/gpt-6.1-sol", "NEXTCMS_DEV_OPENROUTER_API_KEY"],
  ["anthropic", "claude-sonnet-5-5", "NEXTCMS_DEV_ANTHROPIC_API_KEY"],
  ["openai", "gpt-6.1-sol", "NEXTCMS_DEV_OPENAI_API_KEY"],
] as const satisfies readonly [EngineId, string, string][]

const CURRENT_API_KEY_CASES = [
  ["openrouter", "FORMULACMS_DEV_OPENROUTER_API_KEY"],
  ["anthropic", "FORMULACMS_DEV_ANTHROPIC_API_KEY"],
  ["openai", "FORMULACMS_DEV_OPENAI_API_KEY"],
] as const satisfies readonly [EngineId, string][]

describe("local BYOK API engines", () => {
  let fixtureDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.stubEnv("OPENROUTER_API_KEY", "runtime-key-must-be-ignored")
    vi.stubEnv("ANTHROPIC_API_KEY", "runtime-key-must-be-ignored")
    vi.stubEnv("OPENAI_API_KEY", "runtime-key-must-be-ignored")
    vi.stubEnv("NEXTCMS_DEV_OPENROUTER_API_KEY", "dev-openrouter-key")
    vi.stubEnv("NEXTCMS_DEV_ANTHROPIC_API_KEY", "dev-anthropic-key")
    vi.stubEnv("NEXTCMS_DEV_OPENAI_API_KEY", "dev-openai-key")
    fixtureDir = await mkdtemp(join(tmpdir(), "formulacms-api-engine-test-"))
    mocks.generateText.mockImplementation(async ({ model }) => ({
      text: "MODEL OUTPUT",
      finishReason: "stop",
      usage: {
        raw: { reported: true },
        inputTokens: 5,
        outputTokens: 3,
        totalTokens: 8,
      },
      finalStep: {
        response: { modelId: model.modelId },
        providerMetadata:
          model.provider === "openrouter"
            ? { openrouter: { provider: "selected-upstream" } }
            : undefined,
      },
    }))
  })

  afterEach(async () => {
    await rm(fixtureDir, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  test.each(API_CASES)(
    "%s uses its developer-local key and catalog vision tuple",
    async (engineId, expectedModel, envName) => {
      const imagePath = join(fixtureDir, "snapshot.png")
      await writeFile(imagePath, "PNG")
      const request: GenerateRequest = {
        instructions: "SYSTEM PROMPT",
        prompt: "USER PROMPT",
        images: [{ path: imagePath, mediaType: "image/png" }],
        profile: "vision-spec",
        phase: "slice-spec",
      }

      await expect(
        createEngine(engineId, { accounting: createTestAccounting() }).generate(
          request
        )
      ).resolves.toMatchObject({
        text: "MODEL OUTPUT",
        attempts: 1,
        finishReason: "stop",
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        selected: {
          lane: "local-build",
          provider: engineId,
          engine: `${engineId}-api`,
          model: expectedModel,
          effort: "high",
        },
        actual: {
          provider: engineId,
          engine: `${engineId}-api`,
          model: expectedModel,
          effort: "high",
        },
      })

      expect(mocks.createOpenRouter).toHaveBeenCalledTimes(
        engineId === "openrouter" ? 1 : 0
      )
      expect(mocks.createAnthropic).toHaveBeenCalledTimes(
        engineId === "anthropic" ? 1 : 0
      )
      expect(mocks.createOpenAI).toHaveBeenCalledTimes(
        engineId === "openai" ? 1 : 0
      )
      const selectedFactory =
        engineId === "openrouter"
          ? mocks.createOpenRouter
          : engineId === "anthropic"
            ? mocks.createAnthropic
            : mocks.createOpenAI
      expect(selectedFactory).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: process.env[envName] })
      )
      expect(mocks.generateText).toHaveBeenCalledWith(
        expect.objectContaining({
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
          maxRetries: 0,
        })
      )
    }
  )

  test("prefers a formulacms developer key when both namespaces are set", async () => {
    vi.stubEnv("FORMULACMS_DEV_OPENROUTER_API_KEY", "current-key")
    vi.stubEnv("NEXTCMS_DEV_OPENROUTER_API_KEY", "legacy-key")

    await createEngine("openrouter", {
      accounting: createTestAccounting(),
    }).generate({
      instructions: "SYSTEM PROMPT",
      prompt: "USER PROMPT",
      images: [],
      profile: "vision-spec",
      phase: "slice-spec",
    })

    expect(mocks.createOpenRouter).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "current-key" })
    )
  })

  test.each(CURRENT_API_KEY_CASES)(
    "%s accepts its formulacms-only developer key",
    async (engineId, currentName) => {
      const legacyName = API_CASES.find(([id]) => id === engineId)?.[2]
      if (!legacyName) throw new Error(`Missing legacy key for ${engineId}`)
      vi.stubEnv(legacyName, "")
      vi.stubEnv(currentName, "current-only-key")

      await createEngine(engineId, {
        accounting: createTestAccounting(),
      }).generate({
        instructions: "SYSTEM PROMPT",
        prompt: "USER PROMPT",
        images: [],
        profile: "vision-spec",
        phase: "slice-spec",
      })

      const selectedFactory =
        engineId === "openrouter"
          ? mocks.createOpenRouter
          : engineId === "anthropic"
            ? mocks.createAnthropic
            : mocks.createOpenAI
      expect(selectedFactory).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "current-only-key" })
      )
    }
  )

  test("validates model and effort as one local OpenAI tuple", async () => {
    const request: GenerateRequest = {
      instructions: "SYSTEM PROMPT",
      prompt: "USER PROMPT",
      images: [],
      profile: "vision-spec",
      phase: "slice-spec",
    }

    await expect(
      createEngine("openai", {
        accounting: createTestAccounting(),
        engineModel: "gpt-5.6-terra",
        engineEffort: "high",
      }).generate(request)
    ).resolves.toMatchObject({
      selected: {
        provider: "openai",
        engine: "openai-api",
        model: "gpt-5.6-terra",
        effort: "high",
      },
    })
    expect(mocks.responses).toHaveBeenCalledWith("gpt-5.6-terra")
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: { openai: { reasoningEffort: "high" } },
      })
    )
  })

  test.each([
    [{ engineModel: "gpt-5.6-terra" }, /requires --engine-effort/],
    [{ engineEffort: "high" as const }, /requires --engine-model/],
  ])("rejects an incompatible partial API override", async (options, error) => {
    await expect(
      createEngine("openai", {
        ...options,
        accounting: createTestAccounting(),
      }).generate({
        instructions: "SYSTEM PROMPT",
        prompt: "USER PROMPT",
        images: [],
        profile: "vision-spec",
        phase: "slice-spec",
      })
    ).rejects.toThrow(error)
    expect(mocks.createOpenAI).not.toHaveBeenCalled()
    expect(mocks.generateText).not.toHaveBeenCalled()
  })

  test("ignores runtime credentials and fails closed when the selected local key is absent", async () => {
    vi.stubEnv("NEXTCMS_DEV_ANTHROPIC_API_KEY", "")

    await expect(
      createEngine("anthropic", {
        accounting: createTestAccounting(),
      }).generate({
        instructions: "SYSTEM PROMPT",
        prompt: "USER PROMPT",
        images: [],
        profile: "vision-spec",
        phase: "slice-spec",
      })
    ).rejects.toMatchObject({
      category: "CONFIG_MISSING",
      selected: {
        provider: "anthropic",
        engine: "anthropic-api",
      },
      attempts: 0,
      retryable: false,
    })
    expect(mocks.createAnthropic).not.toHaveBeenCalled()
    expect(mocks.generateText).not.toHaveBeenCalled()
  })

  test("keeps the explicit help phase and never falls back when the selected local key is absent", async () => {
    vi.stubEnv("NEXTCMS_DEV_OPENAI_API_KEY", "")

    await expect(
      createEngine("openai", { accounting: createTestAccounting() }).generate({
        instructions: "Answer only from grounded help context.",
        prompt: "Answer the question.",
        images: [],
        profile: "grounded-help",
        phase: "help-answer",
      })
    ).rejects.toMatchObject({
      category: "CONFIG_MISSING",
      phase: "help-answer",
      selected: {
        provider: "openai",
        engine: "openai-api",
        model: "gpt-6-luna",
        effort: "low",
      },
      attempts: 0,
    })
    expect(mocks.createOpenAI).not.toHaveBeenCalled()
    expect(mocks.createOpenRouter).not.toHaveBeenCalled()
    expect(mocks.createAnthropic).not.toHaveBeenCalled()
    expect(mocks.generateText).not.toHaveBeenCalled()
  })

  test("forwards caller cancellation through the local API facade", async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      createEngine("openrouter", {
        accounting: createTestAccounting(),
      }).generate({
        instructions: "SYSTEM PROMPT",
        prompt: "USER PROMPT",
        images: [],
        profile: "vision-spec",
        phase: "slice-spec",
        signal: controller.signal,
      })
    ).rejects.toMatchObject({
      category: "CANCELLED",
      attempts: 0,
      retryable: false,
    })
    expect(mocks.generateText).not.toHaveBeenCalled()
  })
})
