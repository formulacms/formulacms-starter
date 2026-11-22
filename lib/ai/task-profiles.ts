import {
  API_PROVIDERS,
  type ApiModelCapability,
  type ApiModelTuple,
  type ApiProvider,
  type GenerationRequirements,
  type ReasoningEffort,
  type TaskProfile,
  TASK_PROFILES,
} from "./execution-contract"
import type { ModelCatalog } from "./model-catalog"

export const TASK_PROFILE_REQUIREMENTS = {
  "mechanical-translation": {
    inputModalities: ["text"],
    structuredOutput: false,
  },
  "brand-translation": {
    inputModalities: ["text"],
    structuredOutput: false,
  },
  "editorial-copy": {
    inputModalities: ["text"],
    structuredOutput: false,
  },
  "structured-outline-meta": {
    inputModalities: ["text"],
    structuredOutput: true,
  },
  "vision-spec": {
    inputModalities: ["text", "image"],
    structuredOutput: true,
  },
  "renderer-jsx": {
    inputModalities: ["text", "image"],
    structuredOutput: false,
  },
  "grounded-help": {
    inputModalities: ["text"],
    structuredOutput: false,
  },
  "judgment-transform": {
    inputModalities: ["text"],
    structuredOutput: false,
  },
  "explicit-agentic-rescue": {
    inputModalities: ["text"],
    structuredOutput: false,
  },
} as const satisfies Record<TaskProfile, GenerationRequirements>

// Block authoring (`vision-spec`, `renderer-jsx`) moved to the build lane on
// 2026-07-14 (ADR-0032 amendment). Those two profiles remain in the shared
// `TASK_PROFILES` contract so the local API/CLI engines can still resolve
// their tuples, but the runtime picker, task-routing UI, agent registry, and
// site-default eligibility check now see only the editor-facing subset.
export const RUNTIME_TASK_PROFILES = [
  "mechanical-translation",
  "brand-translation",
  "editorial-copy",
  "structured-outline-meta",
  "grounded-help",
] as const satisfies readonly TaskProfile[]

/** One routing vocabulary for assistant settings, readiness and execution. */
export const ASSISTANT_PROFILES = {
  writing: ["editorial-copy", "structured-outline-meta"],
  translation: ["mechanical-translation", "brand-translation"],
  help: ["grounded-help"],
} as const satisfies Record<string, readonly TaskProfile[]>
/** Local-only fourth assistant (the Block creator); deliberately outside
 *  ASSISTANT_PROFILES so live status and module readiness never see it. */
export const BLOCK_CREATOR_PROFILES = ["vision-spec", "renderer-jsx"] as const satisfies readonly TaskProfile[]
export const ASSISTANT_DEFAULT_INSTRUCTIONS = {
  writing:
    "You write clear, friendly web pages. Use short sentences and plain words. Follow the brand voice in Settings › General. Never invent prices, dates or facts.",
  translation:
    "Translate faithfully into the target language. Keep the brand voice, product names and links. Never translate the site name.",
  help: "Answer questions about this admin only. Link to the right screen. If you are not sure, say so.",
} as const

/** Operator instructions precede the code-owned output contract. */
export function prependAssistantInstructions(
  instructions: string | null | undefined,
  contract: string
): string {
  const preamble = instructions?.trim()
  return preamble ? `${preamble}\n\n${contract}` : contract
}

export type AssistantId = keyof typeof ASSISTANT_PROFILES
export const ASSISTANT_IDS = Object.keys(ASSISTANT_PROFILES) as AssistantId[]

/** The Instructions every route sends for an assistant: the owner's saved text
 *  (trimmed), or the code-owned default when nothing was ever saved. */
export function resolveAssistantInstructions(
  id: AssistantId,
  saved: string | undefined
): string {
  return saved === undefined
    ? ASSISTANT_DEFAULT_INSTRUCTIONS[id]
    : saved.trim()
}

export function assistantForProfile(
  profile: TaskProfile
): AssistantId | undefined {
  return ASSISTANT_IDS.find((id) =>
    (ASSISTANT_PROFILES[id] as readonly TaskProfile[]).includes(profile)
  )
}

export const API_TASK_PROFILES = {
  openrouter: {
    "mechanical-translation": catalogTuple(
      "openrouter",
      "google/gemini-2.5-flash-lite",
      "high"
    ),
    "brand-translation": catalogTuple(
      "openrouter",
      "google/gemini-3-flash-preview",
      "medium"
    ),
    "editorial-copy": catalogTuple(
      "openrouter",
      "google/gemini-3-flash-preview",
      "medium"
    ),
    "structured-outline-meta": catalogTuple(
      "openrouter",
      "google/gemini-3-flash-preview",
      "medium"
    ),
    "vision-spec": catalogTuple("openrouter", "openai/gpt-6.1-sol", "high"),
    "renderer-jsx": catalogTuple("openrouter", "openai/gpt-6.1-sol", "high"),
    "grounded-help": catalogTuple(
      "openrouter",
      "google/gemini-2.5-flash-lite",
      "low"
    ),
    "judgment-transform": catalogTuple(
      "openrouter",
      "anthropic/claude-opus-5.5",
      "high"
    ),
    "explicit-agentic-rescue": catalogTuple(
      "openrouter",
      "anthropic/claude-opus-5.5",
      "high"
    ),
  },
  openai: {
    "mechanical-translation": catalogTuple("openai", "gpt-6-luna", "high"),
    "brand-translation": catalogTuple("openai", "gpt-6.1-terra", "low"),
    "editorial-copy": catalogTuple("openai", "gpt-6.1-terra", "low"),
    "structured-outline-meta": catalogTuple(
      "openai",
      "gpt-6.1-terra",
      "medium"
    ),
    "vision-spec": catalogTuple("openai", "gpt-6.1-sol", "high"),
    "renderer-jsx": catalogTuple("openai", "gpt-6.1-sol", "high"),
    "grounded-help": catalogTuple("openai", "gpt-6-luna", "low"),
    "judgment-transform": catalogTuple("openai", "gpt-6.1-sol", "high"),
    "explicit-agentic-rescue": catalogTuple("openai", "gpt-6.1-sol", "xhigh"),
  },
  anthropic: {
    "mechanical-translation": catalogTuple(
      "anthropic",
      "claude-sonnet-5-5",
      "high"
    ),
    "brand-translation": catalogTuple("anthropic", "claude-sonnet-5-5", "medium"),
    "editorial-copy": catalogTuple("anthropic", "claude-sonnet-5-5", "medium"),
    "structured-outline-meta": catalogTuple(
      "anthropic",
      "claude-sonnet-5-5",
      "medium"
    ),
    "vision-spec": catalogTuple("anthropic", "claude-sonnet-5-5", "high"),
    "renderer-jsx": catalogTuple("anthropic", "claude-sonnet-5-5", "high"),
    "grounded-help": catalogTuple("anthropic", "claude-haiku-5-5", "low"),
    "judgment-transform": catalogTuple("anthropic", "claude-opus-5-5", "high"),
    "explicit-agentic-rescue": catalogTuple(
      "anthropic",
      "claude-opus-5-5",
      "xhigh"
    ),
  },
} as const satisfies Record<
  ApiProvider,
  Record<TaskProfile, Readonly<ApiModelTuple>>
>

function catalogTuple(
  provider: ApiProvider,
  model: string,
  effort: ReasoningEffort
): Readonly<Exclude<ApiModelTuple, { mode: "legacy" }>> {
  return Object.freeze({
    mode: "catalog",
    provider,
    model,
    reasoning: Object.freeze({ kind: "effort", effort }),
  }) as Readonly<Exclude<ApiModelTuple, { mode: "legacy" }>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  )
}

function reasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "effort"])) {
    return undefined
  }
  return value.kind === "effort" && typeof value.effort === "string"
    ? (value.effort as ReasoningEffort)
    : undefined
}

/** Shape check, then the catalog entry's efforts: an effort is required
 * exactly when the entry has effort control. A model with no entry, or with
 * unknown capabilities, is refused for every provider. */
export function validateApiModelTuple(
  value: unknown,
  catalog: ModelCatalog
): Readonly<ApiModelTuple> {
  if (!isRecord(value) || typeof value.provider !== "string") {
    throw new Error("Invalid API model tuple.")
  }
  if (!(API_PROVIDERS as readonly string[]).includes(value.provider)) {
    throw new Error("Unsupported API provider tuple.")
  }
  if (value.mode !== "catalog" || typeof value.model !== "string") {
    throw new Error("Only catalog tuples are accepted by this validator.")
  }
  const withEffort = hasExactKeys(value, ["mode", "provider", "model", "reasoning"])
  if (!withEffort && !hasExactKeys(value, ["mode", "provider", "model"])) {
    throw new Error("Invalid API model tuple.")
  }
  const effort = withEffort ? reasoningEffort(value.reasoning) : undefined
  if (withEffort && !effort) throw new Error("Invalid reasoning effort tuple.")

  const reasoning = catalog.get(value.provider as ApiProvider, value.model)
    ?.capability?.reasoning
  if (!reasoning) throw new Error("Unknown model or unknown model capabilities.")
  if (reasoning.kind === "unsupported") {
    if (effort) throw new Error("This model does not accept a reasoning effort.")
    return Object.freeze({ ...value }) as Readonly<ApiModelTuple>
  }
  if (!effort) {
    throw new Error("The model tuple requires one exact reasoning effort.")
  }
  if (!reasoning.supportedEfforts.includes(effort)) {
    throw new Error("Unsupported model and reasoning tuple.")
  }
  return Object.freeze({
    ...value,
    reasoning: Object.freeze({ kind: "effort", effort }),
  }) as Readonly<ApiModelTuple>
}

export function createLegacyOpenRouterTuple(
  model: string
): Readonly<ApiModelTuple> {
  const normalized = model.trim()
  if (!normalized) throw new Error("A legacy OpenRouter model ID is required.")
  return Object.freeze({
    mode: "legacy",
    provider: "openrouter",
    model: normalized,
  })
}

export function taskProfileTuple(
  provider: ApiProvider,
  profile: TaskProfile
): Readonly<Exclude<ApiModelTuple, { mode: "legacy" }>> {
  return API_TASK_PROFILES[provider][profile]
}

export function capabilityForTuple(
  tuple: ApiModelTuple,
  catalog: ModelCatalog
): ApiModelCapability | undefined {
  if (tuple.mode === "legacy") return undefined
  return catalog.get(tuple.provider, tuple.model)?.capability
}

export function tupleMatchesTaskProfile(
  tuple: ApiModelTuple,
  profile: TaskProfile
): boolean {
  if (tuple.mode === "legacy") return true
  const expected = API_TASK_PROFILES[tuple.provider][profile]
  if (expected.model !== tuple.model) return false
  const expectedEffort =
    "reasoning" in expected && expected.reasoning
      ? expected.reasoning.effort
      : undefined
  const actualEffort =
    "reasoning" in tuple && tuple.reasoning ? tuple.reasoning.effort : undefined
  return expectedEffort === actualEffort
}

/** Whether one persisted catalog tuple can safely serve a runtime profile.
 * Mechanical translation is contractually explicit `high`; the two visual
 * authoring profiles also retain their minimum-high gate. */
export function tupleSupportsTaskProfile(
  tuple: ApiModelTuple,
  profile: TaskProfile,
  catalog: ModelCatalog
): boolean {
  if (tuple.mode === "legacy") return false
  const capability = capabilityForTuple(tuple, catalog)
  if (!capability) return false
  const requirements = TASK_PROFILE_REQUIREMENTS[profile]
  const inputModalities = new Set(capability.inputModalities)
  if (
    !requirements.inputModalities.every((modality) =>
      inputModalities.has(modality)
    ) ||
    (requirements.structuredOutput && !capability.structuredOutput)
  ) {
    return false
  }
  if (profile === "mechanical-translation") {
    return "reasoning" in tuple && tuple.reasoning?.effort === "high"
  }
  if (profile === "vision-spec" || profile === "renderer-jsx") {
    return (
      "reasoning" in tuple &&
      tuple.reasoning !== undefined &&
      (["high", "xhigh", "max"] as const).includes(
        tuple.reasoning.effort as "high" | "xhigh" | "max"
      )
    )
  }
  return true
}

export function validateTupleForProfiles(
  value: unknown,
  profiles: readonly TaskProfile[],
  catalog: ModelCatalog
): Readonly<ApiModelTuple> {
  const tuple = validateApiModelTuple(value, catalog)
  if (!profiles.every((profile) => tupleSupportsTaskProfile(tuple, profile, catalog))) {
    throw new Error(
      "The model tuple does not satisfy every required task profile."
    )
  }
  return tuple
}

/** One model a menu offers, with the efforts every serving profile accepts. */
export interface ModelChoice {
  model: string
  name: string
  efforts: ReasoningEffort[]
  providerDefault: ReasoningEffort | null
  family?: string
  releasedAt?: number
  retiresAt?: number
  priceSource?: "committed" | "openrouter"
}

/** Offer only tuples accepted by every profile an assistant serves.
 *  `catalog.list` already drops not-offered, retired, absent, unpriced and
 *  capability-unknown models, newest first. Settings and runs both use this. */
export function assistantModelChoices(
  profiles: readonly TaskProfile[],
  catalog: ModelCatalog,
  now: number
): Record<ApiProvider, ModelChoice[]> {
  const choices: Record<ApiProvider, ModelChoice[]> = {
    anthropic: [], openrouter: [], openai: [],
  }
  for (const provider of API_PROVIDERS) {
    for (const entry of catalog.list(provider, now)) {
      const reasoning = entry.capability!.reasoning
      const supports = (effort: ReasoningEffort | null) => {
        const tuple = { mode: "catalog", provider, model: entry.model,
          ...(effort === null ? {} : { reasoning: { kind: "effort", effort } }),
        } as ApiModelTuple
        try {
          validateTupleForProfiles(tuple, profiles, catalog)
          return true
        } catch {
          return false
        }
      }
      const efforts = reasoning.kind === "effort"
        ? reasoning.supportedEfforts.filter(supports) : []
      if (efforts.length === 0 && (reasoning.kind !== "unsupported" || !supports(null))) continue
      choices[provider].push({
        model: entry.model, name: entry.name, efforts,
        providerDefault: reasoning.kind === "effort" ? entry.defaultEffort : null,
        ...(entry.family ? { family: entry.family } : {}),
        ...(entry.releasedAt === undefined ? {} : { releasedAt: entry.releasedAt }),
        ...(entry.retiresAt === undefined ? {} : { retiresAt: entry.retiresAt }),
        ...(entry.priceSource ? { priceSource: entry.priceSource } : {}),
      })
    }
  }
  return choices
}

/** THE default rule, used by Settings and by every run with nothing saved:
 *  the committed default when it is offered, else the first offered choice
 *  (newest first) with its provider default effort when accepted, else its
 *  first accepted effort. Null when the provider offers nothing. */
export function defaultTupleFor(
  provider: ApiProvider,
  profile: TaskProfile,
  choices: readonly ModelChoice[]
): Exclude<ApiModelTuple, { mode: "legacy" }> | null {
  const primary = taskProfileTuple(provider, profile)
  const effort = "reasoning" in primary ? primary.reasoning?.effort : undefined
  const offered = choices.some((choice) => choice.model === primary.model &&
    (effort === undefined ? choice.efforts.length === 0 : choice.efforts.includes(effort)))
  if (offered) return primary
  const first = choices[0]
  if (!first) return null
  const fallbackEffort = first.providerDefault !== null && first.efforts.includes(first.providerDefault)
    ? first.providerDefault : first.efforts[0]
  return {
    mode: "catalog", provider, model: first.model,
    ...(fallbackEffort ? { reasoning: { kind: "effort", effort: fallbackEffort } } : {}),
  } as Exclude<ApiModelTuple, { mode: "legacy" }>
}

export function assertTaskProfileCatalogComplete(catalog: ModelCatalog): void {
  for (const provider of API_PROVIDERS) {
    for (const profile of TASK_PROFILES) {
      validateApiModelTuple(API_TASK_PROFILES[provider][profile], catalog)
    }
  }
}

/** Total output tokens, including reasoning. Caller limits cannot exceed these. */
export const MAX_OUTPUT_TOKENS: Record<TaskProfile, number> = {
  "mechanical-translation": 65_536,
  "brand-translation": 65_536,
  "editorial-copy": 32_768,
  "structured-outline-meta": 32_768,
  "vision-spec": 65_536,
  "renderer-jsx": 65_536,
  "grounded-help": 32_768,
  "judgment-transform": 65_536,
  "explicit-agentic-rescue": 65_536,
}
export function maxOutputTokensFor(
  request: import("./execution-contract").GenerationRequest<unknown>
): number {
  const effort =
    "reasoning" in request.tuple ? request.tuple.reasoning?.effort : undefined
  const reasoning: Record<ReasoningEffort, number> = {
    none: 0,
    minimal: 1024,
    low: 2048,
    medium: 4096,
    high: 8192,
    xhigh: 16384,
    max: 32768,
  }
  const allowance = effort ? reasoning[effort] : 0
  let text =
    request.profile === "renderer-jsx"
      ? 32_768
      : request.profile === "vision-spec"
        ? 16_384
        : request.profile === "grounded-help"
          ? 4096
          : 8192
  if (request.phase === "translation") {
    const input =
      request.input.prompt ??
      request.input.messages
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : m.content
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("")
        )
        .join("")
    // Up to one output token per source character plus framing and reasoning.
    text = Math.max(1024, input.length + 256)
  }
  return Math.min(MAX_OUTPUT_TOKENS[request.profile], text + allowance)
}
