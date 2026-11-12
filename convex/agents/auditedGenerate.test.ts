// @vitest-environment node
import { describe, expect, test, vi } from "vitest"
import type { ActionCtx } from "../_generated/server"
import { ConvexError, type Value } from "convex/values"
import { sumUsage, withAiAudit } from "./auditedGenerate"

describe("AI SDK usage audit boundary", () => {
  test("persists single-step v7 input, output, and total token usage unchanged", async () => {
    const runMutation = vi.fn(async (reference: unknown, args: unknown) => {
      void reference
      void args
      return null
    })
    const ctx = { runMutation } as unknown as ActionCtx

    await expect(
      withAiAudit(
        ctx,
        {
          authId: "auth:test",
          kind: "field-generate",
          modelId: "openrouter:openai/gpt-test",
        },
        async () => ({
          value: "MODEL OUTPUT",
          usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
          generation: {
            phase: "content-generation",
            selected: {
              lane: "runtime",
              provider: "openrouter",
              model: "openai/gpt-test",
              effort: "medium",
            },
            actual: {
              provider: "openrouter",
              model: "openai/gpt-test-actual",
              effort: "medium",
              routedProvider: "openai",
            },
            attempts: 1,
          },
        })
      )
    ).resolves.toBe("MODEL OUTPUT")

    expect(runMutation).toHaveBeenCalledOnce()
    expect(runMutation.mock.calls[0][1]).toEqual({
      authId: "auth:test",
      kind: "field-generate",
      sliceCount: 0,
      modelId: "openrouter:openai/gpt-test",
      selectedProvider: "openrouter",
      selectedModel: "openai/gpt-test",
      selectedReasoning: "medium",
      actualProvider: "openrouter",
      actualModel: "openai/gpt-test-actual",
      actualReasoning: "medium",
      routedProvider: "openai",
      phase: "content-generation",
      attempts: 1,
      tokenUsage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      },
      success: true,
    })
  })

  test.each([
    ["anthropic", "claude-sonnet-5", "high"],
    ["openai", "gpt-5.6-sol", "high"],
  ] as const)(
    "persists direct %s selected and actual identity without routed-provider metadata",
    async (provider, model, effort) => {
      const runMutation = vi.fn(async (reference: unknown, args: unknown) => {
        void reference
        void args
        return null
      })
      const ctx = { runMutation } as unknown as ActionCtx

      await expect(
        withAiAudit(
          ctx,
          {
            authId: "auth:test",
            kind: "slice-author-propose",
            modelId: model,
          },
          async () => ({
            value: "MODEL OUTPUT",
            usage: { inputTokens: 13, outputTokens: 8, totalTokens: 21 },
            generation: {
              phase: "slice-spec",
              selected: { lane: "runtime", provider, model, effort },
              actual: { provider, model, effort },
              attempts: 1,
            },
          })
        )
      ).resolves.toBe("MODEL OUTPUT")

      expect(runMutation.mock.calls[0]?.[1]).toMatchObject({
        selectedProvider: provider,
        selectedModel: model,
        selectedReasoning: effort,
        actualProvider: provider,
        actualModel: model,
        actualReasoning: effort,
        phase: "slice-spec",
        attempts: 1,
        success: true,
      })
      expect(runMutation.mock.calls[0]?.[1]).not.toHaveProperty(
        "routedProvider"
      )
    }
  )

  test("sums fan-out usage without double-counting precomputed totals", () => {
    expect(
      sumUsage([
        { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        { inputTokens: 7, outputTokens: 4 },
        undefined,
      ])
    ).toEqual({ inputTokens: 10, outputTokens: 6, totalTokens: 16 })
  })

  test("records normalized safe failure metadata", async () => {
    const runMutation = vi.fn(async (reference: unknown, args: unknown) => {
      void reference
      void args
      return null
    })
    const ctx = { runMutation } as unknown as ActionCtx
    const failure = new ConvexError({
      category: "TIMEOUT",
      message: "The request timed out.",
      selected: {
        lane: "runtime",
        provider: "openai",
        model: "gpt-5.6-sol",
        effort: "high",
      },
      attempts: 2,
      phase: "renderer-jsx",
      retryable: true,
      nextAction: "retry-request",
    } as unknown as Value)

    await expect(
      withAiAudit(
        ctx,
        {
          authId: "auth:test",
          kind: "slice-author-propose",
          modelId: "legacy",
        },
        async () => {
          throw failure
        }
      )
    ).rejects.toBe(failure)
    expect(runMutation.mock.calls[0]?.[1]).toMatchObject({
      success: false,
      errorCode: "TIMEOUT",
      selectedProvider: "openai",
      selectedModel: "gpt-5.6-sol",
      selectedReasoning: "high",
      attempts: 2,
      phase: "renderer-jsx",
    })
  })

  test("never lets an audit write mask a successful generation", async () => {
    const runMutation = vi.fn(async () => {
      throw new Error("audit unavailable")
    })
    const ctx = { runMutation } as unknown as ActionCtx
    await expect(
      withAiAudit(
        ctx,
        { authId: "auth:test", kind: "field-generate", modelId: "legacy" },
        async () => ({ value: "ok" })
      )
    ).resolves.toBe("ok")
  })
})
