// Small fixtures copied from the owner-supplied 2026-11-07 models capture.
import { describe, expect, test } from "vitest"
import { parseOpenRouterCatalog } from "./openrouter-catalog"
const fixtures = [
  {
    id: "deepseek/deepseek-v4.1-flash-1017",
    pricing: {
      prompt: "0.00000015",
      completion: "0.0000006",
      input_cache_read: "0.000000003",
      overrides: [
        {
          utc_days: ["saturday", "sunday"],
          prompt: "0.00000015",
          completion: "0.0000006",
          input_cache_read: "0.000000003",
        },
        {
          utc_days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
          utc_start: 0,
          utc_end: 100,
          prompt: "0.00000015",
          completion: "0.0000006",
          input_cache_read: "0.000000003",
        },
        {
          utc_days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
          utc_start: 100,
          utc_end: 400,
          prompt: "0.0000003",
          completion: "0.0000012",
          input_cache_read: "0.000000006",
        },
        {
          utc_days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
          utc_start: 400,
          utc_end: 600,
          prompt: "0.00000015",
          completion: "0.0000006",
          input_cache_read: "0.000000003",
        },
        {
          utc_days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
          utc_start: 600,
          utc_end: 1000,
          prompt: "0.0000003",
          completion: "0.0000012",
          input_cache_read: "0.000000006",
        },
        {
          utc_days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
          utc_start: 1000,
          utc_end: 0,
          prompt: "0.00000015",
          completion: "0.0000006",
          input_cache_read: "0.000000003",
        },
      ],
    },
  },
  {
    id: "anthropic/claude-haiku-5.5",
    pricing: {
      prompt: "0.0000001",
      completion: "0.0000005",
      web_search: "0.01",
      input_cache_read: "0.00000001",
      input_cache_write: "0.000000125",
      input_cache_write_1h: "0.0000002",
      overrides: [
        {
          min_prompt_tokens: 100000,
          prompt: "0.0000005",
          completion: "0.0000025",
          input_cache_read: "0.00000005",
          input_cache_write: "0.000000625",
          input_cache_write_1h: "0.000001",
        },
      ],
    },
  },
  {
    id: "qwen/qwen3.7-flash",
    pricing: {
      prompt: "0.00000003",
      completion: "0.00000013",
      input_cache_read: "0.000000006",
      input_cache_write: "0.000000038",
      overrides: [
        {
          min_prompt_tokens: 32000,
          prompt: "0.0000001",
          completion: "0.0000004",
          input_cache_read: "0.00000002",
          input_cache_write: "0.000000125",
        },
        {
          min_prompt_tokens: 256000,
          prompt: "0.0000002",
          completion: "0.0000008",
          input_cache_read: "0.00000004",
          input_cache_write: "0.00000025",
        },
      ],
    },
  },
  {
    id: "qwen/qwen3-coder-flash",
    pricing: {
      prompt: "0.000000195",
      completion: "0.000000975",
      input_cache_read: "0.000000039",
      input_cache_write: "0.00000024375",
      overrides: [
        {
          min_prompt_tokens: 32000,
          prompt: "0.000000325",
          completion: "0.000001625",
          input_cache_read: "0.000000065",
          input_cache_write: "0.00000040625",
        },
        {
          min_prompt_tokens: 128000,
          prompt: "0.00000052",
          completion: "0.0000026",
          input_cache_read: "0.000000104",
          input_cache_write: "0.00000065",
        },
      ],
    },
  },
]
describe("OpenRouter admission price ceilings", () => {
  test.each(fixtures)(
    "covers conditional prices without changing display: $id",
    (fixture) => {
      const [row] = parseOpenRouterCatalog({ data: [fixture] })
      const prices = [
        fixture.pricing,
        ...(fixture.pricing.overrides ?? []),
      ] as Record<string, unknown>[]
      const max = (keys: string[]) =>
        Math.max(
          ...prices.flatMap((price) =>
            keys.map((key) => Number(price[key] ?? 0))
          )
        )
      expect(row!.ceilingInputPerM).toBeGreaterThanOrEqual(
        max([
          "prompt",
          "input_cache_read",
          "input_cache_write",
          "input_cache_write_1h",
          "image",
          "audio",
          "input_audio_cache",
        ]) * 1e6
      )
      expect(row!.ceilingOutputPerM).toBeGreaterThanOrEqual(
        max(["completion", "internal_reasoning"]) * 1e6
      )
      expect(row!.inputPerM).toBeCloseTo(
        Number(fixture.pricing.prompt) * 1e6,
        6
      )
      expect(row!.outputPerM).toBeCloseTo(
        Number(fixture.pricing.completion) * 1e6,
        6
      )
    }
  )
  test.each([
    { prompt: "-1", completion: "-1" },
    {
      prompt: "0.000001",
      completion: "0.000002",
      overrides: [{ unknown_condition: 1, prompt: "0.0001" }],
    },
    { prompt: "0.000001", completion: "0.000002", request: "0.01" },
    {
      prompt: "0.000001",
      completion: "0.000002",
      overrides: [{ min_prompt_tokens: 32000, prompt: "bad" }],
    },
  ])(
    "refuses incomplete pricing rather than dropping a dimension",
    (pricing) => {
      const [row] = parseOpenRouterCatalog({
        data: [{ id: "fixture/incomplete", pricing }],
      })
      expect(row).not.toHaveProperty("ceilingInputPerM")
      expect(row).not.toHaveProperty("ceilingOutputPerM")
    }
  )
})

test.each([null, undefined])(
  "null/absent overrides are ordinary no-tier rows: %s",
  (overrides) => {
    const [row] = parseOpenRouterCatalog({
      data: [
        {
          id: "fixture/no-tier",
          pricing: {
            prompt: "0.000001",
            completion: "0.000002",
            ...(overrides === undefined ? {} : { overrides }),
          },
        },
      ],
    })
    expect(row!.ceilingInputPerM).toBe(1)
    expect(row!.ceilingOutputPerM).toBe(2)
  }
)
