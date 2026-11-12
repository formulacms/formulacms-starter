import { describe, expect, test } from "vitest"
import {
  effectiveMonthlyCapMicros,
  AI_MONTHLY_CAP_ENFORCED,
  DEFAULT_AI_MONTHLY_CAP_MICROS,
  quote,
  inputTokenEstimate,
  imageTokenEstimate,
  chargeMicros,
  estimateMicros,
  DIRECT_PRICES,
} from "./price-quote"
import { taskProfileTuple } from "./task-profiles"
import { ANTHROPIC_API_CATALOG } from "./capabilities/anthropic-api"
import { OPENAI_API_CATALOG } from "./capabilities/openai-api"
import type {
  GenerationContentPart,
  GenerationRequest,
} from "./execution-contract"
function request(files: GenerationContentPart[] = []): GenerationRequest {
  return {
    target: { lane: "runtime", provider: "openai" },
    tuple: taskProfileTuple("openai", "editorial-copy"),
    profile: "editorial-copy",
    phase: "content-generation",
    requirements: { inputModalities: ["text"], structuredOutput: false },
    output: { kind: "text" },
    input: {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello 世界" }, ...files],
        },
      ],
    },
  }
}
describe("admission quotes and supported inputs", () => {
  test("direct catalog and price keys match exactly", () => {
    const catalogKeys = [
      ...Object.keys(ANTHROPIC_API_CATALOG).map((id) => `anthropic:${id}`),
      ...Object.keys(OPENAI_API_CATALOG).map((id) => `openai:${id}`),
    ]
    expect(Object.keys(DIRECT_PRICES).sort()).toEqual(catalogKeys.sort())
    expect(catalogKeys).toHaveLength(15)
  })
  test("new direct prices use USD rates, highest cache TTL and base input tier", () => {
    expect(Object.fromEntries(
      Object.entries(DIRECT_PRICES).map(([id, p]) => [id, [
        p.inputPerM, p.cacheReadPerM, p.cacheWritePerM, p.outputPerM, p.maxInputTokens,
      ]])
    )).toMatchObject({
      "anthropic:claude-sonnet-5-5": [2_000_000, 100_000, 4_000_000, 10_000_000, 1_000_000],
      "anthropic:claude-opus-5-5": [4_000_000, 200_000, 8_000_000, 20_000_000, 1_000_000],
      "anthropic:claude-haiku-5-5": [100_000, 10_000, 200_000, 500_000, 100_000],
      "anthropic:claude-fable-5-1": [10_000_000, 250_000, 20_000_000, 50_000_000, 1_000_000],
      "openai:gpt-6.1-sol": [2_000_000, 100_000, 5_000_000, 10_000_000, 272_000],
      "openai:gpt-6-astra": [10_000_000, 1_000_000, 25_000_000, 50_000_000, 272_000],
      "openai:gpt-6.1-terra": [1_000_000, 50_000, 2_500_000, 5_000_000, 272_000],
      "openai:gpt-6-sol": [2_000_000, 200_000, 5_000_000, 10_000_000, 272_000],
      "openai:gpt-6-luna": [100_000, 10_000, 250_000, 500_000, 272_000],
    })
    expect(() => quote("anthropic", "claude-haiku-5-5", { inputTokens: 100_001 })).toThrow("base-price tier")
    expect(quote("anthropic", "claude-haiku-5-5", { inputTokens: 100_000 }).revision).toBe("direct-2026-11-09-v1")
  })
  test.each([1, 2])(
    "%i images add exactly 10000 input tokens each",
    (count) => {
      const r = request(
        Array.from({ length: count }, () => ({
          type: "file",
          data: "data:image/png;base64,AAAA",
          mediaType: "image/png",
        }))
      )
      expect(inputTokenEstimate(r) - inputTokenEstimate(request())).toBe(
        10000 * count
      )
      expect(imageTokenEstimate(r)).toBe(10000 * count)
    }
  )
  test("text-only estimate preserves ASCII/3, Unicode code points and message framing", () => {
    expect(inputTokenEstimate(request())).toBe(32 + 32 + 2 + 2)
    expect(imageTokenEstimate(request())).toBe(0)
  })
  test("non-image file inputs are refused", () => {
    expect(() =>
      inputTokenEstimate(
        request([{ type: "file", data: "AAAA", mediaType: "application/pdf" }])
      )
    ).toThrow("non-image")
  })
  test("direct input tiers include image tokens", () => {
    const base = request()
    const text = "a".repeat((272000 - 64 - 9999) * 3)
    const r = {
      ...base,
      input: {
        messages: [
          {
            role: "user" as const,
            content: [
              { type: "text" as const, text },
              { type: "file" as const, data: "AAAA", mediaType: "image/png" },
            ],
          },
        ],
      },
    }
    expect(inputTokenEstimate(r)).toBe(272001)
    expect(() =>
      quote("openai", "gpt-5.6-luna", { inputTokens: inputTokenEstimate(r) })
    ).toThrow("base-price tier")
  })
  test("unknown, expired, incomplete and non-default pricing modes refuse", () => {
    expect(() =>
      quote("openai", "test/not-shipped", { inputTokens: 1 })
    ).toThrow("complete")
    expect(() =>
      quote("openai", "gpt-5.6-sol", {
        inputTokens: 1,
        now: Date.UTC(2026, 11, 1),
      })
    ).toThrow("expired")
    for (const extra of [
      { serviceTier: "priority" },
      { fast: true },
      { priority: true },
      { regional: true },
    ])
      expect(() =>
        quote("openai", "gpt-5.6-luna", { inputTokens: 1, ...extra })
      ).toThrow("processing mode")
    expect(() =>
      quote("openrouter", "google/gemini-3-flash-preview", { inputTokens: 1 })
    ).toThrow("complete")
    expect(() =>
      quote("openrouter", "fixture/legacy", {
        inputTokens: 1,
        catalog: { syncedAt: 1 },
      })
    ).toThrow("complete")
  })
  test("OpenRouter stored ceilings govern reservation and fallback; reported cost wins", () => {
    const p = quote("openrouter", "fixture/priced", {
      inputTokens: 1000000,
      catalog: { syncedAt: 1, ceilingInputPerM: 10, ceilingOutputPerM: 20 },
    })
    expect(estimateMicros(p, 100, 100)).toBe(3000)
    const usage = {
      noCacheInputTokens: 10,
      cacheReadTokens: 20,
      cacheWriteTokens: 30,
      outputTokens: 40,
      reasoningTokens: 30,
    }
    expect(chargeMicros(p, 3000, usage, "completed")).toEqual({
      chargedMicros: 1400,
      costSource: "calculated",
    })
    expect(
      chargeMicros(p, 3000, { ...usage, providerCostUsd: 0.0007 }, "completed")
    ).toEqual({ chargedMicros: 700, costSource: "reported" })
    expect(chargeMicros(p, 3000, {}, "completed")).toEqual({
      chargedMicros: 3000,
      costSource: "estimate",
    })
  })
  test("direct image reservation uses table input rate", () => {
    const p = quote("openai", "gpt-5.6-luna", { inputTokens: 10000 })
    expect(estimateMicros(p, 10000, 0, 10000)).toBe(2000)
  })
})

test("parked monthly cap uses a finite BigInt-safe sentinel and retains enforced behavior", () => {
  expect(AI_MONTHLY_CAP_ENFORCED).toBe(false)
  expect(effectiveMonthlyCapMicros(undefined)).toBe(Number.MAX_SAFE_INTEGER)
  expect(effectiveMonthlyCapMicros(123)).toBe(Number.MAX_SAFE_INTEGER)
  expect(BigInt(effectiveMonthlyCapMicros(0))).toBe(
    BigInt(Number.MAX_SAFE_INTEGER)
  )
  expect(effectiveMonthlyCapMicros(123, true)).toBe(123)
  expect(effectiveMonthlyCapMicros(0, true)).toBe(0)
  expect(effectiveMonthlyCapMicros(undefined, true)).toBe(
    DEFAULT_AI_MONTHLY_CAP_MICROS
  )
})
