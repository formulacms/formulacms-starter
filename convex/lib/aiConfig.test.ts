// @vitest-environment node
import { describe, expect, test } from "vitest"
import {
  DEFAULT_AI_MODEL,
  isRuntimeReady,
  resolveOpenRouterModelId,
  resolveRuntimeSelection,
  resolveRuntimeTuple,
  type RuntimeProviderAvailability,
} from "./aiConfig"

const none: RuntimeProviderAvailability = {
  openrouter: false,
  anthropic: false,
  openai: false,
}

describe("Production AI runtime selection precedence", () => {
  test("observes runtime model changes and falls back after empty or absent values", () => {
    const previous = process.env.CMS_AI_MODEL
    try {
      for (const [value, expected] of [
        ["openrouter:runtime/model", "runtime/model"],
        ["", DEFAULT_AI_MODEL],
        [undefined, DEFAULT_AI_MODEL],
      ] as const) {
        if (value === undefined) delete process.env.CMS_AI_MODEL
        else process.env.CMS_AI_MODEL = value
        expect(resolveOpenRouterModelId()).toBe(expected)
      }
    } finally {
      if (previous === undefined) delete process.env.CMS_AI_MODEL
      else process.env.CMS_AI_MODEL = previous
    }
  })

  test("keeps legacy caller model ahead of CMS_AI_MODEL and normalizes the prefix", () => {
    const previous = process.env.CMS_AI_MODEL
    process.env.CMS_AI_MODEL = "openrouter:environment/model"
    try {
      expect(resolveOpenRouterModelId("openrouter:agent-or-site/model")).toBe(
        "agent-or-site/model"
      )
      expect(resolveOpenRouterModelId(undefined)).toBe("environment/model")
    } finally {
      if (previous === undefined) delete process.env.CMS_AI_MODEL
      else process.env.CMS_AI_MODEL = previous
    }
  })

  test("covers every persisted selection and provider-availability combination", () => {
    const selections = [
      undefined,
      "off",
      "openrouter",
      "anthropic",
      "openai",
    ] as const

    for (const persisted of selections) {
      for (let mask = 0; mask < 8; mask += 1) {
        const availability: RuntimeProviderAvailability = {
          openrouter: Boolean(mask & 1),
          anthropic: Boolean(mask & 2),
          openai: Boolean(mask & 4),
        }
        const resolved = resolveRuntimeSelection(persisted, availability)

        if (persisted === undefined) {
          expect(resolved).toMatchObject(
            availability.openrouter
              ? {
                  selectedProvider: "openrouter",
                  effectiveProvider: "openrouter",
                  status: "legacy-openrouter",
                  legacy: true,
                }
              : {
                  selectedProvider: "off",
                  effectiveProvider: null,
                  status: "off",
                  legacy: false,
                }
          )
        } else if (persisted === "off") {
          expect(resolved).toMatchObject({
            selectedProvider: "off",
            effectiveProvider: null,
            status: "off",
            legacy: false,
          })
        } else {
          expect(resolved).toMatchObject({
            selectedProvider: persisted,
            effectiveProvider: persisted,
            status: availability[persisted]
              ? "ready"
              : "selected-unavailable",
            legacy: false,
          })
        }
        expect(resolved.availability).toEqual(availability)
      }
    }
  })

  test("uses only the legacy OpenRouter compatibility path when selection is absent", () => {
    expect(
      resolveRuntimeSelection(undefined, { ...none, openrouter: true })
    ).toMatchObject({
      selectedProvider: "openrouter",
      effectiveProvider: "openrouter",
      status: "legacy-openrouter",
      legacy: true,
    })
    expect(
      resolveRuntimeSelection(undefined, { ...none, anthropic: true, openai: true })
    ).toMatchObject({
      selectedProvider: "off",
      effectiveProvider: null,
      status: "off",
      legacy: false,
    })
  })

  test("keeps an explicit provider selected and fails closed when its key is absent", () => {
    expect(
      resolveRuntimeSelection("anthropic", { ...none, openrouter: true })
    ).toMatchObject({
      selectedProvider: "anthropic",
      effectiveProvider: "anthropic",
      status: "selected-unavailable",
      legacy: false,
    })
  })

  test("reports explicit ready and off selections without credential inference", () => {
    const ready = resolveRuntimeSelection("openai", { ...none, openai: true })
    expect(ready).toMatchObject({
      selectedProvider: "openai",
      effectiveProvider: "openai",
      status: "ready",
      legacy: false,
    })
    expect(isRuntimeReady(ready)).toBe(true)

    expect(
      resolveRuntimeSelection("off", {
        openrouter: true,
        anthropic: true,
        openai: true,
      })
    ).toMatchObject({
      selectedProvider: "off",
      effectiveProvider: null,
      status: "off",
      legacy: false,
    })
  })

  test("resolves typed agent override before site default before catalog", () => {
    const selection = resolveRuntimeSelection("openai", { ...none, openai: true })
    const site = {
      mode: "catalog",
      provider: "openai",
      model: "gpt-5.6-terra",
      reasoning: { kind: "effort", effort: "high" },
    } as const
    const agent = {
      mode: "catalog",
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoning: { kind: "effort", effort: "high" },
    } as const

    expect(
      resolveRuntimeTuple({
        selection,
        profile: "vision-spec",
        providerDefaults: { openai: site },
        modelOverrides: { openai: agent },
      })
    ).toEqual({ tuple: agent, source: "agent" })
    expect(
      resolveRuntimeTuple({
        selection,
        profile: "vision-spec",
        providerDefaults: { openai: site },
      })
    ).toEqual({ tuple: site, source: "site" })
    expect(
      resolveRuntimeTuple({ selection, profile: "vision-spec" })
    ).toMatchObject({ source: "catalog", tuple: { provider: "openai" } })
  })

  test("resolves task default between agent override and site default", () => {
    const selection = resolveRuntimeSelection("openai", { ...none, openai: true })
    const site = {
      mode: "catalog",
      provider: "openai",
      model: "gpt-5.6-terra",
      reasoning: { kind: "effort", effort: "high" },
    } as const
    const task = {
      mode: "catalog",
      provider: "openai",
      model: "gpt-5.6-terra",
      reasoning: { kind: "effort", effort: "xhigh" },
    } as const
    const agent = {
      mode: "catalog",
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoning: { kind: "effort", effort: "high" },
    } as const

    // agent > task > site > catalog.
    expect(
      resolveRuntimeTuple({
        selection,
        profile: "vision-spec",
        providerDefaults: { openai: site },
        taskDefaults: { "vision-spec": task },
        modelOverrides: { openai: agent },
      })
    ).toEqual({ tuple: agent, source: "agent" })
    expect(
      resolveRuntimeTuple({
        selection,
        profile: "vision-spec",
        providerDefaults: { openai: site },
        taskDefaults: { "vision-spec": task },
      })
    ).toEqual({ tuple: task, source: "task" })
    expect(
      resolveRuntimeTuple({
        selection,
        profile: "vision-spec",
        taskDefaults: { "vision-spec": task },
      })
    ).toEqual({ tuple: task, source: "task" })
  })

  test("falls through when the task default targets a different provider", () => {
    const selection = resolveRuntimeSelection("openai", { ...none, openai: true })
    const site = {
      mode: "catalog",
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoning: { kind: "effort", effort: "high" },
    } as const
    // Stale entry from an earlier Anthropic selection — must not hard-error the
    // generation; must not clobber the still-valid OpenAI site default.
    const staleTask = {
      mode: "catalog",
      provider: "anthropic",
      model: "claude-sonnet-5",
      reasoning: { kind: "effort", effort: "high" },
    } as const

    expect(
      resolveRuntimeTuple({
        selection,
        profile: "vision-spec",
        providerDefaults: { openai: site },
        taskDefaults: { "vision-spec": staleTask },
      })
    ).toEqual({ tuple: site, source: "site" })
  })

  test("falls through when the task default fails the profile capability gate", () => {
    const selection = resolveRuntimeSelection("openai", { ...none, openai: true })
    const site = {
      mode: "catalog",
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoning: { kind: "effort", effort: "high" },
    } as const
    // vision-spec has a `high` effort floor — a `low` tuple does not qualify.
    const lowEffortTask = {
      mode: "catalog",
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoning: { kind: "effort", effort: "low" },
    } as const

    expect(
      resolveRuntimeTuple({
        selection,
        profile: "vision-spec",
        providerDefaults: { openai: site },
        taskDefaults: { "vision-spec": lowEffortTask },
      })
    ).toEqual({ tuple: site, source: "site" })
  })

  test("keeps legacy selection isolated and rejects an incompatible persisted tuple", () => {
    const legacy = resolveRuntimeSelection(undefined, { ...none, openrouter: true })
    expect(
      resolveRuntimeTuple({
        selection: legacy,
        profile: "mechanical-translation",
        legacyModelId: "openrouter:legacy/model",
      })
    ).toEqual({
      source: "legacy",
      tuple: { mode: "legacy", provider: "openrouter", model: "legacy/model" },
    })

    const typed = resolveRuntimeSelection("openai", { ...none, openai: true })
    expect(() =>
      resolveRuntimeTuple({
        selection: typed,
        profile: "mechanical-translation",
        providerDefaults: {
          openai: {
            mode: "catalog",
            provider: "openai",
            model: "gpt-5.6-luna",
            reasoning: { kind: "effort", effort: "low" },
          },
        },
      })
    ).toThrow(/incompatible/)
  })
})

test("S3 fallback profile changes only catalog precedence and rejects incompatible defaults", async () => {
  const { taskProfileTuple } = await import("../../lib/ai/task-profiles")
  const selection = resolveRuntimeSelection("openai", { ...none, openai: true })
  const args = { selection, profile: "brand-translation" as const, fallbackProfile: "mechanical-translation" as const }
  expect(resolveRuntimeTuple(args)).toEqual({ tuple: taskProfileTuple("openai", "mechanical-translation"), source: "catalog" })
  // The non-assistant default remains per task.
  expect(resolveRuntimeTuple({ selection, profile: "brand-translation" })).toEqual({ tuple: taskProfileTuple("openai", "brand-translation"), source: "catalog" })
  const tuple = taskProfileTuple("openai", "editorial-copy") as NonNullable<import("./aiConfig").ProviderModelSelections["openai"]>
  for (const [overrides, source] of [
    [{ providerDefaults: { openai: tuple } }, "site"],
    [{ taskDefaults: { "brand-translation": tuple } }, "task"],
    [{ modelOverrides: { openai: tuple } }, "agent"],
  ] as const) {
    expect(resolveRuntimeTuple({ ...args, ...overrides })).toEqual({ tuple, source })
  }
  expect(() => resolveRuntimeTuple({ ...args, profile: "mechanical-translation", fallbackProfile: "editorial-copy" })).toThrow(
    "Persisted AI model selection is incompatible with this task profile."
  )
})
