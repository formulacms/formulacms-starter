import { describe, expect, test } from "vitest"
import {
  BUNDLED_MODEL_CATALOG,
  buildCatalogModel,
  catalogFromEntries,
  familyFromName,
  isOpenAiTextModel,
  menuOrder,
  newerModelFor,
  NOT_OFFERED_MODELS,
  openRouterIdFor,
  parseAnthropicModels,
  parseOpenAiModels,
  refusal,
  type CatalogModel,
  type OpenRouterRow,
  type VendorModel,
} from "./model-catalog"
import { ANTHROPIC_API_CATALOG } from "./capabilities/anthropic-api"
import { OPENAI_API_CATALOG } from "./capabilities/openai-api"
import { parseOpenRouterCatalog, parseOpenRouterRows } from "./openrouter-catalog"

const NOW = Date.UTC(2026, 10, 15)
const SYNCED_AT = Date.UTC(2026, 10, 15, 6)
const DAY_MS = 24 * 60 * 60 * 1_000

// Cut from the live OpenRouter feed, 2026-11-15 (descriptions and unused fields removed).
const FEED = {
  data: [
    { id: "openai/gpt-6.1-sol", name: "OpenAI: GPT-6.1 Sol", created: 1790702882, context_length: 1050000, architecture: { input_modalities: ["file", "image", "text"], output_modalities: ["text"] }, pricing: { prompt: "0.000002", completion: "0.00001", web_search: "0.01", input_cache_read: "0.0000001", input_cache_write: "0.0000025", overrides: [{ min_prompt_tokens: 272000, prompt: "0.000004", completion: "0.000015", input_cache_read: "0.0000002", input_cache_write: "0.000005" }] }, top_provider: { max_completion_tokens: 128000 }, supported_parameters: ["include_reasoning", "max_completion_tokens", "max_tokens", "reasoning", "reasoning_effort", "response_format", "seed", "structured_outputs", "tool_choice", "tools", "verbosity"], expiration_date: null, reasoning: { mandatory: true, default_enabled: true, supported_efforts: ["max", "xhigh", "high", "medium", "low"], default_effort: "medium" } },
    { id: "openai/gpt-6-luna:batch", name: "OpenAI: GPT-6 Luna (batch)", created: 1790100786, context_length: 1050000, architecture: { input_modalities: ["file", "image", "text"], output_modalities: ["text"] }, pricing: { prompt: "0.00000005", completion: "0.00000025" }, top_provider: { max_completion_tokens: 128000 }, supported_parameters: ["reasoning", "structured_outputs"], expiration_date: null, reasoning: { mandatory: false, supported_efforts: ["max", "xhigh", "high", "medium", "low", "none"], default_effort: "medium" } },
    { id: "openai/gpt-6-sol", name: "OpenAI: GPT-6 Sol", created: 1790100775, context_length: 1050000, architecture: { input_modalities: ["file", "image", "text"], output_modalities: ["text"] }, pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000002", input_cache_write: "0.0000025" }, top_provider: { max_completion_tokens: 128000 }, supported_parameters: ["reasoning", "reasoning_effort", "structured_outputs"], expiration_date: null, reasoning: { mandatory: false, default_enabled: true, supported_efforts: ["max", "xhigh", "high", "medium", "low", "none"], default_effort: "medium" } },
    { id: "anthropic/claude-opus-5.5", name: "Anthropic: Claude Opus 5.5", created: 1790094732, context_length: 1000000, architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] }, pricing: { prompt: "0.000004", completion: "0.00002", web_search: "0.01", input_cache_read: "0.0000002", input_cache_write: "0.000005", input_cache_write_1h: "0.000008" }, top_provider: { max_completion_tokens: 128000 }, supported_parameters: ["include_reasoning", "max_completion_tokens", "max_tokens", "reasoning", "reasoning_effort", "response_format", "stop", "structured_outputs", "tool_choice", "tools", "verbosity"], expiration_date: null, reasoning: { mandatory: true, supported_efforts: ["max", "xhigh", "high", "medium", "low"], default_effort: "high" } },
    { id: "openai/gpt-chat-latest", name: "OpenAI: GPT Chat Latest", created: 1778000212, context_length: 400000, architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] }, pricing: { prompt: "0.000005", completion: "0.00003" }, top_provider: { max_completion_tokens: 128000 }, supported_parameters: ["structured_outputs"], expiration_date: null },
    { id: "~anthropic/claude-opus-latest", name: "Anthropic: Claude Opus Latest", created: 1776795361, context_length: 1000000, architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] }, pricing: { prompt: "0.000004", completion: "0.00002" }, top_provider: { max_completion_tokens: 128000 }, supported_parameters: ["reasoning", "structured_outputs"], expiration_date: null, alias_target: { name: "Anthropic: Claude Opus 5.5", slug: "anthropic/claude-opus-5.5" }, reasoning: { mandatory: true, supported_efforts: ["max", "xhigh", "high", "medium", "low"], default_effort: "high" } },
    { id: "anthropic/claude-haiku-4.5", name: "Anthropic: Claude Haiku 4.5", created: 1760547638, context_length: 200000, architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] }, pricing: { prompt: "0.000001", completion: "0.000005", input_cache_read: "0.0000001", input_cache_write: "0.00000125", input_cache_write_1h: "0.000002" }, top_provider: { max_completion_tokens: 64000 }, supported_parameters: ["reasoning", "response_format", "structured_outputs"], expiration_date: null, reasoning: { mandatory: false } },
    { id: "anthropic/claude-sonnet-4.5", name: "Anthropic: Claude Sonnet 4.5", created: 1759161676, context_length: 1000000, architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] }, pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003", input_cache_write: "0.00000375", input_cache_write_1h: "0.000006", overrides: [{ min_prompt_tokens: 200000, prompt: "0.000006", completion: "0.0000225", input_cache_read: "0.0000006", input_cache_write: "0.0000075", input_cache_write_1h: "0.000012" }] }, top_provider: { max_completion_tokens: 64000 }, supported_parameters: ["reasoning", "structured_outputs"], expiration_date: "2026-12-31", reasoning: { mandatory: false } },
  ],
}

const synced = (rows = parseOpenRouterRows(FEED)): Map<string, OpenRouterRow> =>
  new Map(rows.map((row) => [row.modelId, { ...row, syncedAt: SYNCED_AT }]))

/** The live GPT-6.1 Sol row under a new id, as a future model would appear. */
function futureOpenRouterRow(id: string, name: string, created: number): OpenRouterRow {
  return { ...synced().get("openai/gpt-6.1-sol")!, modelId: id, name, releasedAt: created }
}

const anthropicVendor = (row: Record<string, unknown>) =>
  parseAnthropicModels({ data: [row] })[0]!

const OPUS_6 = {
  type: "model",
  id: "claude-opus-6",
  display_name: "Claude Opus 6",
  created_at: "2026-11-10T00:00:00Z",
  line: "opus",
  max_input_tokens: 1_000_000,
  max_tokens: 128_000,
  lifecycle: "active",
  deprecated_at: null,
  retires_at: null,
  capabilities: {
    image_input: { supported: true },
    pdf_input: { supported: true },
    structured_outputs: { supported: true },
    effort: {
      supported: true,
      low: { supported: true },
      medium: { supported: true },
      high: { supported: true },
      xhigh: { supported: true },
      max: { supported: true },
      ultra: { supported: true },
    },
  },
}

describe("OpenRouter feed rows", () => {
  test("drop :batch ids and rolling aliases, keep the extra facts", () => {
    const rows = parseOpenRouterRows(FEED)
    expect(rows.map((row) => row.modelId)).toEqual([
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-opus-5.5",
      "anthropic/claude-sonnet-4.5",
      "openai/gpt-6-sol",
      "openai/gpt-6.1-sol",
    ])
    const sol = rows.find((row) => row.modelId === "openai/gpt-6.1-sol")!
    expect(sol).toMatchObject({
      releasedAt: 1790702882_000,
      hasReasoning: true,
      vendorEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      reasoningMandatory: true,
      contextLength: 1_050_000,
      maxOutputTokens: 128_000,
      reasoningEfforts: ["high", "medium", "low"],
      ceilingInputPerM: 5,
      ceilingOutputPerM: 15,
    })
    expect(rows.find((row) => row.modelId === "openai/gpt-6-sol")!.vendorEfforts).toContain("none")
    const haiku = rows.find((row) => row.modelId === "anthropic/claude-haiku-4.5")!
    expect(haiku.hasReasoning).toBe(true)
    expect(haiku).not.toHaveProperty("vendorEfforts")
    expect(rows.find((row) => row.modelId === "anthropic/claude-sonnet-4.5")!.expiresAt).toBe(
      Date.UTC(2026, 11, 31)
    )
  })

  test("the stored-row parser keeps today's rows and shape", () => {
    const rows = parseOpenRouterCatalog(FEED)
    expect(rows).toHaveLength(FEED.data.length)
    for (const row of rows) {
      expect(Object.keys(row).every((name) =>
        ["modelId", "name", "inputModalities", "structuredOutput", "reasoningEfforts",
          "inputPerM", "outputPerM", "ceilingInputPerM", "ceilingOutputPerM"].includes(name)
      )).toBe(true)
    }
  })
})

describe("vendor list parsers", () => {
  test("Anthropic: capabilities, unknowns and placeholders", () => {
    const models = parseAnthropicModels({
      data: [
        OPUS_6,
        { ...OPUS_6, display_name: "duplicate" },
        {
          id: "claude-haiku-4-5-20251001",
          display_name: "Claude Haiku 4.5",
          line: "haiku",
          created_at: "2025-10-01T00:00:00Z",
          lifecycle: "active",
          capabilities: {
            image_input: { supported: true },
            pdf_input: { supported: false },
            structured_outputs: { supported: true },
            effort: { supported: false },
          },
        },
        { id: "claude-mystery-1", created_at: "1970-01-01T00:00:00Z", max_input_tokens: 0, capabilities: null, lifecycle: "gone" },
        { display_name: "no id" },
        "not a row",
      ],
    })
    expect(models.map((model) => model.modelId)).toEqual([
      "claude-opus-6",
      "claude-haiku-4-5-20251001",
      "claude-mystery-1",
    ])
    expect(models[0]).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-6",
      name: "Claude Opus 6",
      line: "opus",
      releasedAt: Date.UTC(2026, 10, 10),
      inputModalities: ["text", "image", "file"],
      structuredOutput: true,
      effortControl: "effort",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
      lifecycle: "active",
    })
    expect(models[1]).toMatchObject({ effortControl: "none", inputModalities: ["text", "image"] })
    expect(models[2]).toEqual({ provider: "anthropic", modelId: "claude-mystery-1", effortControl: "unknown" })
    expect(() => parseAnthropicModels({ data: Array(501).fill(OPUS_6) })).toThrow("at most 500")
    expect(() => parseAnthropicModels({})).toThrow("invalid model list")
  })

  test.each([
    ["gpt-6.1-sol", "openai", true],
    ["gpt-7-sol", "system", true],
    ["o4-mini", "openai", true],
    ["gpt-6.1-sol", "acme-org", false],
    ["ft:gpt-6-luna:acme::abc", "acme-org", false],
    ["gpt-6-astra-pro", "openai", false],
    ["gpt-6-pro-2026-01-01", "openai", false],
    ["gpt-realtime-2", "openai", false],
    ["gpt-image-2", "openai", false],
    ["gpt-6-search-preview", "openai", false],
    ["gpt-chat-latest", "openai", false],
    ["text-embedding-3-large", "openai", false],
    ["dall-e-3", "system", false],
  ])("OpenAI filter: %s owned by %s → %s", (id, ownedBy, kept) => {
    expect(isOpenAiTextModel(id, ownedBy)).toBe(kept)
  })

  test("OpenAI: keeps text models with release and shutdown dates", () => {
    expect(
      parseOpenAiModels({
        object: "list",
        data: [
          { id: "gpt-7-sol", object: "model", created: 1_794_000_000, owned_by: "openai" },
          { id: "gpt-5", created: 1_754_000_000, owned_by: "system", shutdown_date: "2026-12-11" },
          { id: "tts-2", created: 1, owned_by: "openai" },
        ],
      })
    ).toEqual([
      { provider: "openai", modelId: "gpt-7-sol", releasedAt: 1_794_000_000_000 },
      { provider: "openai", modelId: "gpt-5", releasedAt: 1_754_000_000_000, retiresAt: Date.UTC(2026, 11, 11) },
    ])
  })
})

describe("id mapping", () => {
  test.each([
    ["anthropic", "claude-opus-5-5", "anthropic/claude-opus-5.5"],
    ["anthropic", "claude-sonnet-5", "anthropic/claude-sonnet-5"],
    ["anthropic", "claude-haiku-4-5-20251001", "anthropic/claude-haiku-4.5"],
    ["anthropic", "claude-3-5-haiku-20241022", undefined],
    ["openai", "gpt-6.1-sol", "openai/gpt-6.1-sol"],
    ["openai", "gpt-6-astra-pro", undefined],
    ["openai", "gpt-6-luna:batch", undefined],
    ["openrouter", "openai/gpt-6.1-sol", undefined],
  ] as const)("%s %s → %s", (provider, model, expected) => {
    expect(openRouterIdFor(provider, model)).toBe(expected)
  })

  test("the display-name check guards the Anthropic mapping", () => {
    const row = synced().get("anthropic/claude-sonnet-4.5")
    const vendor = (name: string): VendorModel =>
      anthropicVendor({ ...OPUS_6, id: "claude-sonnet-4-5-20250929", display_name: name, line: "sonnet" })
    const matched = buildCatalogModel({
      provider: "anthropic", model: "claude-sonnet-4-5-20250929",
      vendorRow: vendor("Claude Sonnet 4.5"), openRouterRow: row, hasLiveList: true,
    })
    expect(matched.priceSource).toBe("openrouter")
    const mismatched = buildCatalogModel({
      provider: "anthropic", model: "claude-sonnet-4-5-20250929",
      vendorRow: vendor("Claude Sonnet 4.5 Preview"), openRouterRow: row, hasLiveList: true,
    })
    expect(mismatched.price).toBeUndefined()
    // A row for a different id is ignored outright.
    expect(buildCatalogModel({
      provider: "anthropic", model: "claude-opus-6",
      vendorRow: anthropicVendor(OPUS_6), openRouterRow: row, hasLiveList: true,
    }).price).toBeUndefined()
  })
})

describe("merge precedence", () => {
  test("committed data wins over the vendor and OpenRouter", () => {
    const entry = buildCatalogModel({
      provider: "anthropic",
      model: "claude-opus-5-5",
      vendorRow: { ...anthropicVendor({ ...OPUS_6, id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }), efforts: ["high"] },
      openRouterRow: synced().get("anthropic/claude-opus-5.5"),
      hasLiveList: true,
    })
    expect(entry).toMatchObject({
      capabilitySource: "committed",
      defaultEffort: "medium", // OpenRouter says high; the committed file says medium.
      priceSource: "committed",
      listed: "live",
      family: "Opus",
      releasedAt: Date.UTC(2026, 10, 10),
    })
    expect(entry.capability?.reasoning).toMatchObject({
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    })
  })

  test("Anthropic: the vendor's capabilities beat OpenRouter; the price is filled from the ceiling", () => {
    const entry = buildCatalogModel({
      provider: "anthropic",
      model: "claude-opus-6",
      vendorRow: anthropicVendor(OPUS_6),
      openRouterRow: { ...futureOpenRouterRow("anthropic/claude-opus-6", "Anthropic: Claude Opus 6", NOW), vendorEfforts: ["high"] },
      hasLiveList: true,
    })
    expect(entry.capabilitySource).toBe("vendor")
    expect(entry.capability?.reasoning).toMatchObject({ supportedEfforts: ["low", "medium", "high", "xhigh", "max"] })
    expect(entry.priceSource).toBe("openrouter")
    expect(entry.price).toMatchObject({
      revision: `openrouter-${SYNCED_AT}`,
      sourceUrl: "https://openrouter.ai/api/v1/models",
      endsAt: null,
      maxInputTokens: 1_000_000,
    })
  })

  test("OpenAI: capabilities and price come from the mapped OpenRouter row, erring high", () => {
    const entry = buildCatalogModel({
      provider: "openai",
      model: "gpt-7-sol",
      vendorRow: { provider: "openai", modelId: "gpt-7-sol", releasedAt: NOW },
      openRouterRow: futureOpenRouterRow("openai/gpt-7-sol", "OpenAI: GPT-7 Sol", NOW),
      hasLiveList: true,
    })
    expect(entry).toMatchObject({ name: "GPT-7 Sol", family: "Sol", capabilitySource: "openrouter", defaultEffort: "medium" })
    // Base prompt 2 / completion 10 per million; the long-context tier and cache
    // writes reach 5 / 15, and the ceiling takes the highest.
    expect(entry.price).toMatchObject({ inputPerM: 5_000_000, cacheWritePerM: 5_000_000, outputPerM: 15_000_000, maxInputTokens: Number.MAX_SAFE_INTEGER })
    expect(refusal(entry, { reasoning: { effort: "high" } }, NOW)).toBeNull()
  })

  test("unpriced or capability-unknown models are never listed", () => {
    const unpriced = buildCatalogModel({ provider: "anthropic", model: "claude-opus-6", vendorRow: anthropicVendor(OPUS_6), hasLiveList: true })
    const unknownOpenAi = buildCatalogModel({ provider: "openai", model: "gpt-7-terra", vendorRow: { provider: "openai", modelId: "gpt-7-terra" }, hasLiveList: true })
    // A row stored before the new optional fields existed.
    const beforeNewFields = { ...futureOpenRouterRow("openai/gpt-7-luna", "OpenAI: GPT-7 Luna", NOW), hasReasoning: undefined }
    const staleRow = buildCatalogModel({ provider: "openai", model: "gpt-7-luna", vendorRow: { provider: "openai", modelId: "gpt-7-luna" }, openRouterRow: beforeNewFields, hasLiveList: true })
    expect(refusal(unpriced, {}, NOW)).toBe("no-price")
    expect(refusal(unknownOpenAi, {}, NOW)).toBe("capabilities-unknown")
    expect(refusal(staleRow, {}, NOW)).toBe("capabilities-unknown")
    const catalog = catalogFromEntries([unpriced, unknownOpenAi, staleRow])
    expect(catalog.list("anthropic", NOW)).toEqual([])
    expect(catalog.list("openai", NOW)).toEqual([])
    expect(catalog.get("anthropic", "claude-opus-6")).toBe(unpriced)
  })
})

describe("not-offered list", () => {
  test("hides GPT-6 Sol from bundled and live lists; a saved choice is refused", () => {
    expect(NOT_OFFERED_MODELS).toContain("openai:gpt-6-sol")
    const ids = (catalog: typeof BUNDLED_MODEL_CATALOG, provider: "openai" | "openrouter") =>
      catalog.list(provider, NOW).map((entry) => entry.model)
    expect(ids(BUNDLED_MODEL_CATALOG, "openai")).not.toContain("gpt-6-sol")
    expect(BUNDLED_MODEL_CATALOG.get("openai", "gpt-6-sol")?.name).toBe("GPT-6 Sol")
    expect(refusal(BUNDLED_MODEL_CATALOG.get("openai", "gpt-6-sol"), { reasoning: { effort: "high" } }, NOW)).toBe("not-offered")

    const rows = synced()
    const live = catalogFromEntries([
      buildCatalogModel({ provider: "openai", model: "gpt-6-sol", vendorRow: { provider: "openai", modelId: "gpt-6-sol" }, openRouterRow: rows.get("openai/gpt-6-sol"), hasLiveList: true }),
      buildCatalogModel({ provider: "openai", model: "gpt-6.1-sol", vendorRow: { provider: "openai", modelId: "gpt-6.1-sol" }, openRouterRow: rows.get("openai/gpt-6.1-sol"), hasLiveList: true }),
      ...[...rows.values()].map((row) => buildCatalogModel({ provider: "openrouter", model: row.modelId, openRouterRow: row, hasLiveList: true })),
    ])
    expect(ids(live, "openai")).toEqual(["gpt-6.1-sol"])
    expect(ids(live, "openrouter")).not.toContain("openai/gpt-6-sol")
    expect(ids(live, "openrouter")).toContain("openai/gpt-6.1-sol")
  })

  test("hides GPT-6 Sol Pro from the OpenRouter list; a saved choice is refused", () => {
    expect(NOT_OFFERED_MODELS).toContain("openrouter:openai/gpt-6-sol-pro")
    expect(BUNDLED_MODEL_CATALOG.list("openrouter", NOW).map((entry) => entry.model)).not.toContain("openai/gpt-6-sol-pro")
    const saved = BUNDLED_MODEL_CATALOG.get("openrouter", "openai/gpt-6-sol-pro")
    expect(saved).toBeDefined()
    expect(refusal(saved, { reasoning: { effort: "high" } }, NOW)).toBe("not-offered")

    const rows = synced()
    const live = catalogFromEntries(
      [...rows.values()].map((row) => buildCatalogModel({ provider: "openrouter", model: row.modelId, openRouterRow: row, hasLiveList: true }))
    )
    expect(live.list("openrouter", NOW).map((entry) => entry.model)).not.toContain("openai/gpt-6-sol-pro")
  })
})

describe("bundled catalog", () => {
  test("offers today's direct membership in committed order, minus not-offered and ending prices", () => {
    expect(BUNDLED_MODEL_CATALOG.list("anthropic", NOW).map((entry) => entry.model)).toEqual(Object.keys(ANTHROPIC_API_CATALOG))
    expect(BUNDLED_MODEL_CATALOG.list("openai", NOW).map((entry) => entry.model)).toEqual(
      Object.keys(OPENAI_API_CATALOG).filter((model) => model !== "gpt-6-sol" && model !== "gpt-5.6-sol")
    )
    expect(BUNDLED_MODEL_CATALOG.get("openai", "gpt-5.6-sol")?.priceSource).toBe("committed")
  })

  test("OpenRouter bundle rows are priced from the ceilings computed when the bundle was generated", () => {
    const entry = BUNDLED_MODEL_CATALOG.get("openrouter", "openai/gpt-6.1-sol")
    expect(entry).toMatchObject({ listed: "bundled", capabilitySource: "vendor" })
    expect(entry).toMatchObject({ priceSource: "openrouter" })
    expect(entry?.price?.revision).toMatch(/^openrouter-\d+$/)
    const offered = BUNDLED_MODEL_CATALOG.list("openrouter", NOW)
    expect(offered.length).toBeGreaterThan(0)
    expect(offered.every((item) => item.price !== undefined)).toBe(true)
    expect(BUNDLED_MODEL_CATALOG.get("openrouter", "~anthropic/claude-opus-latest")).toBeUndefined()
    expect(BUNDLED_MODEL_CATALOG.get("openrouter", "openai/gpt-6-luna:batch")).toBeUndefined()
  })
})

describe("refusal reasons", () => {
  const opus = BUNDLED_MODEL_CATALOG.get("anthropic", "claude-opus-5-5")
  const haiku = BUNDLED_MODEL_CATALOG.get("anthropic", "claude-haiku-4-5-20251001")
  const sol = BUNDLED_MODEL_CATALOG.get("openai", "gpt-6.1-sol")

  test.each<[string, CatalogModel | undefined, { reasoning?: { effort: "none" | "high" } }, number, ReturnType<typeof refusal>]>([
    ["accepted", opus, { reasoning: { effort: "high" } }, NOW, null],
    ["no effort model without effort", haiku, {}, NOW, null],
    ["unknown model", undefined, {}, NOW, "unknown-model"],
    ["effort required", opus, {}, NOW, "effort-required"],
    ["effort not accepted", sol, { reasoning: { effort: "none" } }, NOW, "effort-not-accepted"],
    ["effort unsupported", haiku, { reasoning: { effort: "high" } }, NOW, "effort-unsupported"],
    ["price expired", BUNDLED_MODEL_CATALOG.get("openai", "gpt-5.6-sol"), { reasoning: { effort: "high" } }, Date.UTC(2026, 11, 1), "price-expired"],
  ])("%s", (_label, entry, tuple, now, expected) => {
    expect(refusal(entry, tuple, now)).toBe(expected)
  })

  test("retired, past shutdown, absent and missing from a live list", () => {
    const vendor = anthropicVendor({ ...OPUS_6, id: "claude-opus-5-5" })
    const build = (vendorRow: VendorModel | undefined, provider: "anthropic" | "openai" = "anthropic", model = "claude-opus-5-5") =>
      buildCatalogModel({ provider, model, vendorRow, hasLiveList: true })
    const effort = { reasoning: { effort: "high" as const } }
    expect(refusal(build({ ...vendor, lifecycle: "retired" }), effort, NOW)).toBe("retired")
    expect(refusal(build({ ...vendor, absentSince: NOW - 1 }), effort, NOW)).toBe("not-listed")
    expect(refusal(build(undefined), effort, NOW)).toBe("not-listed")
    const shutdown = build({ provider: "openai", modelId: "gpt-6.1-sol", retiresAt: NOW + 1 }, "openai", "gpt-6.1-sol")
    expect(shutdown.lifecycle).toBe("deprecated")
    expect(refusal(shutdown, effort, NOW)).toBeNull()
    expect(refusal(shutdown, effort, NOW + 1)).toBe("retired")
  })
})

// Round-1 review guards (AI-MODELS-1b fix F).
describe("review 1b guards", () => {
  test("#4 the generated bundle carries expiration dates: offered before, retired after", () => {
    const entry = BUNDLED_MODEL_CATALOG.get("openrouter", "z-ai/glm-5.1")
    expect(entry).toMatchObject({ lifecycle: "deprecated", retiresAt: Date.UTC(2026, 10, 20) })
    expect(entry?.releasedAt).toEqual(expect.any(Number))
    const before = Date.UTC(2026, 10, 19)
    const after = Date.UTC(2026, 10, 21)
    expect(refusal(entry, { reasoning: { effort: "high" } }, before)).toBeNull()
    expect(BUNDLED_MODEL_CATALOG.list("openrouter", before).map((e) => e.model)).toContain("z-ai/glm-5.1")
    expect(refusal(entry, { reasoning: { effort: "high" } }, after)).toBe("retired")
    expect(BUNDLED_MODEL_CATALOG.list("openrouter", after).map((e) => e.model)).not.toContain("z-ai/glm-5.1")
  })

  test("#4 bundled OpenRouter rows are ordered newest first by their release dates", () => {
    const offered = BUNDLED_MODEL_CATALOG.list("openrouter", NOW)
    const dated = offered.filter((e) => e.releasedAt !== undefined)
    expect(dated.length).toBeGreaterThan(offered.length / 2)
    expect(dated.map((e) => e.releasedAt)).toEqual([...dated.map((e) => e.releasedAt!)].sort((a, b) => b - a))
  })

  test.each(["~openai/gpt-latest", "openai/gpt-chat-latest", "openai/gpt-7-sol:batch"])(
    "#3 a stored OpenRouter %s row is not offered and refused",
    (model) => {
      const entry = buildCatalogModel({
        provider: "openrouter",
        model,
        openRouterRow: { ...synced().get("openai/gpt-6.1-sol")!, modelId: model },
        hasLiveList: true,
      })
      expect(entry.price).toBeDefined()
      expect(refusal(entry, { reasoning: { effort: "high" } }, NOW)).toBe("not-offered")
      expect(catalogFromEntries([entry]).list("openrouter", NOW)).toEqual([])
    }
  )

  test("#7 Anthropic: deprecated past its date stays offered; retired is refused; OpenAI dates still retire", () => {
    const vendor = anthropicVendor({ ...OPUS_6, id: "claude-opus-5-5" })
    const build = (row: VendorModel) =>
      buildCatalogModel({ provider: row.provider, model: row.modelId, vendorRow: row, hasLiveList: true })
    const effort = { reasoning: { effort: "high" as const } }
    const overdue = build({ ...vendor, lifecycle: "deprecated", retiresAt: NOW - DAY_MS })
    expect(refusal(overdue, effort, NOW)).toBeNull()
    expect(catalogFromEntries([overdue]).list("anthropic", NOW).map((e) => e.model)).toEqual(["claude-opus-5-5"])
    expect(refusal(build({ ...vendor, lifecycle: "retired", retiresAt: NOW - DAY_MS }), effort, NOW)).toBe("retired")
    const openAi = build({ provider: "openai", modelId: "gpt-6.1-sol", retiresAt: NOW - DAY_MS })
    expect(refusal(openAi, effort, NOW)).toBe("retired")
  })
})

describe("menu order and newer models", () => {
  const entry = (model: string, name: string, releasedAt?: number): CatalogModel =>
    buildCatalogModel({
      provider: "openai",
      model,
      vendorRow: { provider: "openai", modelId: model, ...(releasedAt ? { releasedAt } : {}) },
      openRouterRow: futureOpenRouterRow(`openai/${model}`, `OpenAI: ${name}`, releasedAt ?? NOW),
      hasLiveList: true,
    })

  test("newest first, then name; undated rows after in their order", () => {
    const undatedB = { ...entry("gpt-b", "B"), releasedAt: undefined }
    const undatedA = { ...entry("gpt-a", "A"), releasedAt: undefined }
    const order = menuOrder([undatedB, entry("gpt-old", "Old", 1), undatedA, entry("gpt-z", "Z", 5), entry("gpt-y", "Y", 5)])
    expect(order.map((item) => item.model)).toEqual(["gpt-y", "gpt-z", "gpt-old", "gpt-b", "gpt-a"])
  })

  test("names the newest offered model of the same family only when it is newer", () => {
    const sol61 = entry("gpt-6.1-sol", "GPT-6.1 Sol", Date.UTC(2026, 8, 29))
    const sol7 = entry("gpt-7-sol", "GPT-7 Sol", Date.UTC(2026, 10, 10))
    const terra7 = entry("gpt-7-terra", "GPT-7 Terra", Date.UTC(2026, 10, 12))
    const catalog = catalogFromEntries([sol61, sol7, terra7])
    expect(newerModelFor(sol61, catalog, NOW)?.model).toBe("gpt-7-sol")
    expect(newerModelFor(sol7, catalog, NOW)).toBeUndefined()
    expect(familyFromName("Anthropic: Claude Opus 5.5")).toBe("Opus")
    expect(familyFromName("GPT-6.1 Terra")).toBe("Terra")
  })
})
