import { describe, expect, test } from "vitest"
import type { AnthropicApiTuple } from "./capabilities/anthropic-api"
import type { OpenAIApiTuple } from "./capabilities/openai-api"
import {
  ANTHROPIC_API_CATALOG,
  ANTHROPIC_API_SOURCES,
} from "./capabilities/anthropic-api"
import {
  OPENAI_API_CATALOG,
  OPENAI_API_SOURCES,
} from "./capabilities/openai-api"
import {
  OPENROUTER_API_CATALOG,
  OPENROUTER_API_SOURCES,
} from "./capabilities/openrouter-api"
import {
  API_PROVIDERS,
  TASK_PROFILES,
  tupleEffort,
  type ApiModelTuple,
  type ApiModelCapability,
} from "./execution-contract"
import {
  API_TASK_PROFILES,
  assertTaskProfileCatalogComplete,
  RUNTIME_TASK_PROFILES,
  taskProfileTuple,
  tupleSupportsTaskProfile,
  assistantForProfile,
  ASSISTANT_PROFILES,
  validateTupleForProfiles,
  validateApiModelTuple,
} from "./task-profiles"

test("one profile-to-assistant map covers all runtime profiles and excludes slice authoring", () => {
  expect(ASSISTANT_PROFILES).toEqual({ writing: ["editorial-copy", "structured-outline-meta"], translation: ["mechanical-translation", "brand-translation"], help: ["grounded-help"] })
  expect(assistantForProfile("structured-outline-meta")).toBe("writing")
  expect(assistantForProfile("mechanical-translation")).toBe("translation")
  expect(assistantForProfile("grounded-help")).toBe("help")
  expect(assistantForProfile("vision-spec")).toBeUndefined()
})

describe("source-stamped API catalogs", () => {
  test("openrouter catalog is generated, priced, and effort-aware", () => {
    // OpenRouter is generated from the live list
    // (scripts/sync-openrouter-catalog.ts), so assert shape, not a full golden.
    const entries = Object.entries(OPENROUTER_API_CATALOG)
    expect(entries.length).toBeGreaterThan(100)
    for (const [, cap] of entries) {
      expect(cap.outputModalities).toEqual(["text"])
      expect(typeof cap.name).toBe("string")
    }
    const sonnet = OPENROUTER_API_CATALOG["anthropic/claude-sonnet-5"]
    expect(sonnet?.reasoning.kind).toBe("effort")
    expect(sonnet?.pricing?.inputPerM).toBeGreaterThan(0)
  })

  test("goldens every hand-curated provider row", () => {
    expect({
      openai: OPENAI_API_CATALOG,
      anthropic: ANTHROPIC_API_CATALOG,
    }).toMatchInlineSnapshot(`
      {
        "anthropic": {
          "claude-fable-5-1": {
            "inputModalities": [
              "text",
              "image",
            ],
            "name": "Claude Fable 5.1",
            "outputModalities": [
              "text",
            ],
            "reasoning": {
              "kind": "effort",
              "providerDefault": "high",
              "supportedEfforts": [
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ],
            },
            "structuredOutput": true,
          },
          "claude-haiku-4-5-20251001": {
            "inputModalities": [
              "text",
              "image",
            ],
            "name": "Claude Haiku 4.5",
            "outputModalities": [
              "text",
            ],
            "reasoning": {
              "kind": "unsupported",
            },
            "structuredOutput": true,
          },
          "claude-haiku-5-5": {
            "inputModalities": [
              "text",
              "image",
            ],
            "name": "Claude Haiku 5.5",
            "outputModalities": [
              "text",
            ],
            "reasoning": {
              "kind": "effort",
              "providerDefault": "medium",
              "supportedEfforts": [
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ],
            },
            "structuredOutput": true,
          },
          "claude-opus-4-8": {
            "inputModalities": [
              "text",
              "image",
            ],
            "name": "Claude Opus 4.8",
            "outputModalities": [
              "text",
            ],
            "reasoning": {
              "kind": "effort",
              "providerDefault": "high",
              "supportedEfforts": [
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ],
            },
            "structuredOutput": true,
          },
          "claude-opus-5-5": {
            "inputModalities": [
              "text",
              "image",
            ],
            "name": "Claude Opus 5.5",
            "outputModalities": [
              "text",
            ],
            "reasoning": {
              "kind": "effort",
              "providerDefault": "medium",
              "supportedEfforts": [
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ],
            },
            "structuredOutput": true,
          },
          "claude-sonnet-5": {
            "inputModalities": [
              "text",
              "image",
            ],
            "name": "Claude Sonnet 5",
            "outputModalities": [
              "text",
            ],
            "reasoning": {
              "kind": "effort",
              "providerDefault": "high",
              "supportedEfforts": [
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ],
            },
            "structuredOutput": true,
          },
          "claude-sonnet-5-5": {
            "inputModalities": [
              "text",
              "image",
            ],
            "name": "Claude Sonnet 5.5",
            "outputModalities": [
              "text",
            ],
            "reasoning": {
              "kind": "effort",
              "providerDefault": "high",
              "supportedEfforts": [
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ],
            },
            "structuredOutput": true,
          },
        },
        "openai": {
          "gpt-5.6-luna": {
            "inputModalities": [
              "text",
              "image",
            ],
            "name": "GPT-5.6 Luna",
            "outputModalities": [
              "text",
            ],
            "reasoning": {
              "kind": "effort",
              "providerDefault": "medium",
              "supportedEfforts": [
                "none",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ],
            },
            "structuredOutput": true,
          },
          "gpt-5.6-sol": {
            "inputModalities": [
              "text",
              "image",
            ],
            "name": "GPT-5.6 Sol",
            "outputModalities": [
              "text",
            ],
            "reasoning": {
              "kind": "effort",
              "providerDefault": "medium",
              "supportedEfforts": [
                "none",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ],
            },
            "structuredOutput": true,
          },
          "gpt-5.6-terra": {
            "inputModalities": [
              "text",
              "image",
            ],
            "name": "GPT-5.6 Terra",
            "outputModalities": [
              "text",
            ],
            "reasoning": {
              "kind": "effort",
              "providerDefault": "medium",
              "supportedEfforts": [
                "none",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ],
            },
            "structuredOutput": true,
          },
          "gpt-6-astra": {
            "inputModalities": [
              "text",
              "image",
            ],
            "name": "GPT-6 Astra",
            "outputModalities": [
              "text",
            ],
            "reasoning": {
              "kind": "effort",
              "providerDefault": "medium",
              "supportedEfforts": [
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ],
            },
            "structuredOutput": true,
          },
          "gpt-6-luna": {
            "inputModalities": [
              "text",
              "image",
            ],
            "name": "GPT-6 Luna",
            "outputModalities": [
              "text",
            ],
            "reasoning": {
              "kind": "effort",
              "providerDefault": "medium",
              "supportedEfforts": [
                "none",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ],
            },
            "structuredOutput": true,
          },
          "gpt-6-sol": {
            "inputModalities": [
              "text",
              "image",
            ],
            "name": "GPT-6 Sol",
            "outputModalities": [
              "text",
            ],
            "reasoning": {
              "kind": "effort",
              "providerDefault": "medium",
              "supportedEfforts": [
                "none",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ],
            },
            "structuredOutput": true,
          },
          "gpt-6.1-sol": {
            "inputModalities": [
              "text",
              "image",
            ],
            "name": "GPT-6.1 Sol",
            "outputModalities": [
              "text",
            ],
            "reasoning": {
              "kind": "effort",
              "providerDefault": "medium",
              "supportedEfforts": [
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ],
            },
            "structuredOutput": true,
          },
          "gpt-6.1-terra": {
            "inputModalities": [
              "text",
              "image",
            ],
            "name": "GPT-6.1 Terra",
            "outputModalities": [
              "text",
            ],
            "reasoning": {
              "kind": "effort",
              "providerDefault": "medium",
              "supportedEfforts": [
                "none",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ],
            },
            "structuredOutput": true,
          },
        },
      }
    `)
  })

  test("source stamps cover every provider and use the reviewed retrieval date", () => {
    for (const [sources, retrievedAt] of [
      [OPENROUTER_API_SOURCES, "2026-07-12"],
      [OPENAI_API_SOURCES, "2026-11-09"],
      [ANTHROPIC_API_SOURCES, "2026-11-09"],
    ] as const) {
      expect(sources.length).toBeGreaterThan(0)
      for (const source of sources) {
        expect(source).toMatchObject({
          url: expect.stringMatching(/^https:\/\//),
          retrievedAt,
          claim: expect.any(String),
        })
      }
    }
  })
})

describe("task-profile tuple goldens", () => {
  test("covers every provider/profile mapping exactly", () => {
    expect(API_TASK_PROFILES).toMatchInlineSnapshot(`
      {
        "anthropic": {
          "brand-translation": {
            "mode": "catalog",
            "model": "claude-sonnet-5-5",
            "provider": "anthropic",
            "reasoning": {
              "effort": "medium",
              "kind": "effort",
            },
          },
          "editorial-copy": {
            "mode": "catalog",
            "model": "claude-sonnet-5-5",
            "provider": "anthropic",
            "reasoning": {
              "effort": "medium",
              "kind": "effort",
            },
          },
          "explicit-agentic-rescue": {
            "mode": "catalog",
            "model": "claude-opus-5-5",
            "provider": "anthropic",
            "reasoning": {
              "effort": "xhigh",
              "kind": "effort",
            },
          },
          "grounded-help": {
            "mode": "catalog",
            "model": "claude-haiku-5-5",
            "provider": "anthropic",
            "reasoning": {
              "effort": "low",
              "kind": "effort",
            },
          },
          "judgment-transform": {
            "mode": "catalog",
            "model": "claude-opus-5-5",
            "provider": "anthropic",
            "reasoning": {
              "effort": "high",
              "kind": "effort",
            },
          },
          "mechanical-translation": {
            "mode": "catalog",
            "model": "claude-sonnet-5-5",
            "provider": "anthropic",
            "reasoning": {
              "effort": "high",
              "kind": "effort",
            },
          },
          "renderer-jsx": {
            "mode": "catalog",
            "model": "claude-sonnet-5-5",
            "provider": "anthropic",
            "reasoning": {
              "effort": "high",
              "kind": "effort",
            },
          },
          "structured-outline-meta": {
            "mode": "catalog",
            "model": "claude-sonnet-5-5",
            "provider": "anthropic",
            "reasoning": {
              "effort": "medium",
              "kind": "effort",
            },
          },
          "vision-spec": {
            "mode": "catalog",
            "model": "claude-sonnet-5-5",
            "provider": "anthropic",
            "reasoning": {
              "effort": "high",
              "kind": "effort",
            },
          },
        },
        "openai": {
          "brand-translation": {
            "mode": "catalog",
            "model": "gpt-6.1-terra",
            "provider": "openai",
            "reasoning": {
              "effort": "low",
              "kind": "effort",
            },
          },
          "editorial-copy": {
            "mode": "catalog",
            "model": "gpt-6.1-terra",
            "provider": "openai",
            "reasoning": {
              "effort": "low",
              "kind": "effort",
            },
          },
          "explicit-agentic-rescue": {
            "mode": "catalog",
            "model": "gpt-6.1-sol",
            "provider": "openai",
            "reasoning": {
              "effort": "xhigh",
              "kind": "effort",
            },
          },
          "grounded-help": {
            "mode": "catalog",
            "model": "gpt-6-luna",
            "provider": "openai",
            "reasoning": {
              "effort": "low",
              "kind": "effort",
            },
          },
          "judgment-transform": {
            "mode": "catalog",
            "model": "gpt-6.1-sol",
            "provider": "openai",
            "reasoning": {
              "effort": "high",
              "kind": "effort",
            },
          },
          "mechanical-translation": {
            "mode": "catalog",
            "model": "gpt-6-luna",
            "provider": "openai",
            "reasoning": {
              "effort": "high",
              "kind": "effort",
            },
          },
          "renderer-jsx": {
            "mode": "catalog",
            "model": "gpt-6.1-sol",
            "provider": "openai",
            "reasoning": {
              "effort": "high",
              "kind": "effort",
            },
          },
          "structured-outline-meta": {
            "mode": "catalog",
            "model": "gpt-6.1-terra",
            "provider": "openai",
            "reasoning": {
              "effort": "medium",
              "kind": "effort",
            },
          },
          "vision-spec": {
            "mode": "catalog",
            "model": "gpt-6.1-sol",
            "provider": "openai",
            "reasoning": {
              "effort": "high",
              "kind": "effort",
            },
          },
        },
        "openrouter": {
          "brand-translation": {
            "mode": "catalog",
            "model": "google/gemini-3-flash-preview",
            "provider": "openrouter",
            "reasoning": {
              "effort": "medium",
              "kind": "effort",
            },
          },
          "editorial-copy": {
            "mode": "catalog",
            "model": "google/gemini-3-flash-preview",
            "provider": "openrouter",
            "reasoning": {
              "effort": "medium",
              "kind": "effort",
            },
          },
          "explicit-agentic-rescue": {
            "mode": "catalog",
            "model": "anthropic/claude-opus-4.8",
            "provider": "openrouter",
            "reasoning": {
              "effort": "high",
              "kind": "effort",
            },
          },
          "grounded-help": {
            "mode": "catalog",
            "model": "google/gemini-2.5-flash-lite",
            "provider": "openrouter",
            "reasoning": {
              "effort": "low",
              "kind": "effort",
            },
          },
          "judgment-transform": {
            "mode": "catalog",
            "model": "anthropic/claude-opus-4.8",
            "provider": "openrouter",
            "reasoning": {
              "effort": "high",
              "kind": "effort",
            },
          },
          "mechanical-translation": {
            "mode": "catalog",
            "model": "google/gemini-2.5-flash-lite",
            "provider": "openrouter",
            "reasoning": {
              "effort": "high",
              "kind": "effort",
            },
          },
          "renderer-jsx": {
            "mode": "catalog",
            "model": "openai/gpt-5.6-sol",
            "provider": "openrouter",
            "reasoning": {
              "effort": "high",
              "kind": "effort",
            },
          },
          "structured-outline-meta": {
            "mode": "catalog",
            "model": "google/gemini-3-flash-preview",
            "provider": "openrouter",
            "reasoning": {
              "effort": "medium",
              "kind": "effort",
            },
          },
          "vision-spec": {
            "mode": "catalog",
            "model": "openai/gpt-5.6-sol",
            "provider": "openrouter",
            "reasoning": {
              "effort": "high",
              "kind": "effort",
            },
          },
        },
      }
    `)
    expect(Object.keys(API_TASK_PROFILES).sort()).toEqual(
      [...API_PROVIDERS].sort()
    )
    for (const provider of API_PROVIDERS) {
      expect(Object.keys(API_TASK_PROFILES[provider])).toEqual(TASK_PROFILES)
    }
    expect(() => assertTaskProfileCatalogComplete()).not.toThrow()
  })

  test("uses explicit high mechanical translation and never defaults to none", () => {
    for (const provider of API_PROVIDERS) {
      expect(
        tupleEffort(taskProfileTuple(provider, "mechanical-translation"))
      ).toBe("high")
      for (const profile of TASK_PROFILES) {
        expect(tupleEffort(taskProfileTuple(provider, profile))).not.toBe(
          "none"
        )
      }
    }
  })

  test("defaults Haiku 5.5 to low and freezes every committed tuple", () => {
    const tuple = taskProfileTuple("anthropic", "grounded-help")
    expect(tuple).toEqual({
      mode: "catalog",
      provider: "anthropic",
      model: "claude-haiku-5-5",
      reasoning: { kind: "effort", effort: "low" },
    })
    expect(Object.isFrozen(tuple)).toBe(true)

    for (const provider of API_PROVIDERS) {
      for (const profile of TASK_PROFILES) {
        const mapped = taskProfileTuple(provider, profile)
        expect(Object.isFrozen(mapped)).toBe(true)
        if ("reasoning" in mapped && mapped.reasoning) {
          expect(Object.isFrozen(mapped.reasoning)).toBe(true)
        }
      }
    }
  })
})

describe("API tuple validation", () => {
  test("returns deeply frozen validated tuples", () => {
    const validated = validateApiModelTuple({
      mode: "catalog",
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoning: { kind: "effort", effort: "high" },
    })
    expect(Object.isFrozen(validated)).toBe(true)
    expect(
      Object.isFrozen(
        (validated as Extract<ApiModelTuple, { provider: "openai" }>).reasoning
      )
    ).toBe(true)
  })

  test.each([
    ["partial", { provider: "openai", model: "gpt-5.6-sol" }],
    [
      "missing reasoning",
      { mode: "catalog", provider: "openai", model: "gpt-5.6-sol" },
    ],
    [
      "extraneous tuple field",
      {
        mode: "catalog",
        provider: "openai",
        model: "gpt-5.6-sol",
        reasoning: { kind: "effort", effort: "high" },
        apiKey: "must-not-pass",
      },
    ],
    [
      "extraneous reasoning field",
      {
        mode: "catalog",
        provider: "openai",
        model: "gpt-5.6-sol",
        reasoning: { kind: "effort", effort: "high", budget: 1 },
      },
    ],
    [
      "unsupported effort",
      {
        mode: "catalog",
        provider: "openrouter",
        model: "google/gemini-3.5-flash",
        reasoning: { kind: "effort", effort: "xhigh" },
      },
    ],
    [
      "Haiku effort",
      {
        mode: "catalog",
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        reasoning: { kind: "effort", effort: "low" },
      },
    ],
  ])("rejects %s", (_label, value) => {
    expect(() => validateApiModelTuple(value)).toThrow()
  })
})

describe("D3 persisted selection policy", () => {
  test("keeps the approved OpenRouter runtime defaults used by Settings", () => {
    expect(
      Object.fromEntries(
        RUNTIME_TASK_PROFILES.map((profile) => [
          profile,
          API_TASK_PROFILES.openrouter[profile],
        ])
      )
    ).toEqual({
      "mechanical-translation": {
        mode: "catalog",
        provider: "openrouter",
        model: "google/gemini-2.5-flash-lite",
        reasoning: { kind: "effort", effort: "high" },
      },
      "brand-translation": {
        mode: "catalog",
        provider: "openrouter",
        model: "google/gemini-3-flash-preview",
        reasoning: { kind: "effort", effort: "medium" },
      },
      "editorial-copy": {
        mode: "catalog",
        provider: "openrouter",
        model: "google/gemini-3-flash-preview",
        reasoning: { kind: "effort", effort: "medium" },
      },
      "structured-outline-meta": {
        mode: "catalog",
        provider: "openrouter",
        model: "google/gemini-3-flash-preview",
        reasoning: { kind: "effort", effort: "medium" },
      },
      "grounded-help": {
        mode: "catalog",
        provider: "openrouter",
        model: "google/gemini-2.5-flash-lite",
        reasoning: { kind: "effort", effort: "low" },
      },
    })
  })

  test("exposes exactly the runtime profiles Production AI can route", () => {
    // After the 2026-07-14 ADR-0032 amendment `vision-spec` / `renderer-jsx`
    // stay in the shared TASK_PROFILES contract (the local build-lane engines
    // still resolve tuples for them) but are no longer runtime-facing.
    expect(RUNTIME_TASK_PROFILES).toEqual([
      "mechanical-translation",
      "brand-translation",
      "editorial-copy",
      "structured-outline-meta",
      "grounded-help",
    ])
    expect(RUNTIME_TASK_PROFILES).not.toContain("vision-spec")
    expect(RUNTIME_TASK_PROFILES).not.toContain("renderer-jsx")
    expect(RUNTIME_TASK_PROFILES).not.toContain("judgment-transform")
    expect(RUNTIME_TASK_PROFILES).not.toContain("explicit-agentic-rescue")
  })

  test("keeps mechanical effort exactly high and visual effort minimum-high", () => {
    const tuple = (effort: "low" | "high" | "xhigh" | "max") =>
      validateApiModelTuple({
        mode: "catalog",
        provider: "openai",
        model: "gpt-5.6-sol",
        reasoning: { kind: "effort", effort },
      })
    expect(
      tupleSupportsTaskProfile(tuple("high"), "mechanical-translation")
    ).toBe(true)
    expect(
      tupleSupportsTaskProfile(tuple("xhigh"), "mechanical-translation")
    ).toBe(false)
    expect(tupleSupportsTaskProfile(tuple("low"), "vision-spec")).toBe(false)
    expect(tupleSupportsTaskProfile(tuple("xhigh"), "vision-spec")).toBe(true)
    expect(tupleSupportsTaskProfile(tuple("max"), "renderer-jsx")).toBe(true)
  })

  test("requires a universal site default to satisfy every runtime profile", () => {
    expect(() =>
      validateTupleForProfiles(
        {
          mode: "catalog",
          provider: "openai",
          model: "gpt-5.6-sol",
          reasoning: { kind: "effort", effort: "high" },
        },
        RUNTIME_TASK_PROFILES
      )
    ).not.toThrow()
    expect(() =>
      validateTupleForProfiles(
        {
          mode: "catalog",
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
        },
        RUNTIME_TASK_PROFILES
      )
    ).toThrow(/every required task profile/)
  })
})


test("all direct provider defaults and profile efforts belong to their own model", () => {
  for (const catalog of [ANTHROPIC_API_CATALOG, OPENAI_API_CATALOG]) {
    for (const cap of Object.values(catalog) as ApiModelCapability[]) {
      if (cap.reasoning.kind === "effort") {
        expect(cap.reasoning.supportedEfforts).toContain(cap.reasoning.providerDefault)
      }
    }
  }
  for (const provider of ["anthropic", "openai"] as const) {
    for (const profile of TASK_PROFILES) {
      const tuple = taskProfileTuple(provider, profile)
      const catalog: Record<string, ApiModelCapability> = provider === "anthropic" ? ANTHROPIC_API_CATALOG : OPENAI_API_CATALOG
      const cap = catalog[tuple.model]!
      expect(tupleSupportsTaskProfile(tuple, profile)).toBe(true)
      expect(cap.reasoning.kind).toBe("effort")
      if (cap.reasoning.kind === "effort") {
        expect(cap.reasoning.supportedEfforts).toContain(tupleEffort(tuple))
      }
    }
  }
})

test("new model effort restrictions preserve saved no-effort Haiku", () => {
  for (const model of ["gpt-6.1-sol", "gpt-6-astra"]) {
    for (const effort of ["none", "minimal"]) {
      expect(() => validateApiModelTuple({
        mode: "catalog", provider: "openai", model,
        reasoning: { kind: "effort", effort },
      })).toThrow("Unsupported")
    }
  }
  expect(validateApiModelTuple({
    mode: "catalog", provider: "openai", model: "gpt-6.1-terra",
    reasoning: { kind: "effort", effort: "none" },
  })).toMatchObject({ reasoning: { effort: "none" } })
  expect(validateApiModelTuple({
    mode: "catalog", provider: "anthropic", model: "claude-haiku-4-5-20251001",
  })).toEqual({ mode: "catalog", provider: "anthropic", model: "claude-haiku-4-5-20251001" })
})


test("direct picker order keeps successors first and all saved models available", () => {
  expect(Object.keys(ANTHROPIC_API_CATALOG)).toEqual([
    "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1",
    "claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5-20251001",
  ])
  expect(Object.keys(OPENAI_API_CATALOG)).toEqual([
    "gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna",
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
  ])
})

test("direct tuple types reject model-specific unsupported efforts", () => {
  // @ts-expect-error GPT-6.1 Sol cannot disable reasoning.
  const sol: OpenAIApiTuple = { mode: "catalog", provider: "openai", model: "gpt-6.1-sol", reasoning: { kind: "effort", effort: "none" } }
  // @ts-expect-error Astra cannot disable reasoning either.
  const astra: OpenAIApiTuple = { mode: "catalog", provider: "openai", model: "gpt-6-astra", reasoning: { kind: "effort", effort: "none" } }
  // @ts-expect-error Haiku 4.5 accepts no reasoning field, even though 5.5 does.
  const haiku: AnthropicApiTuple = { mode: "catalog", provider: "anthropic", model: "claude-haiku-4-5-20251001", reasoning: { kind: "effort", effort: "high" } }
  for (const tuple of [sol, astra, haiku]) {
    expect(() => validateApiModelTuple(tuple)).toThrow()
  }
})
