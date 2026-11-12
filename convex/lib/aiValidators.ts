import { v, type Validator } from "convex/values"

export const runtimeApiProviderValidator = v.union(
  v.literal("openrouter"),
  v.literal("anthropic"),
  v.literal("openai")
)

export const executionLaneValidator = v.union(
  v.literal("runtime"),
  v.literal("local-build")
)

export const generationEngineValidator = v.union(
  v.literal("openrouter-api"),
  v.literal("anthropic-api"),
  v.literal("openai-api"),
  v.literal("claude-cli"),
  v.literal("codex-cli")
)

export const generationIdentityEvidenceValidator = v.union(
  v.literal("runtime-observed"),
  v.literal("transcript-observed"),
  v.literal("selected-only")
)

export const runtimeSelectedProviderValidator = v.union(
  runtimeApiProviderValidator,
  v.literal("off")
)

export const runtimeProviderAvailabilityValidator = v.object({
  openrouter: v.boolean(),
  anthropic: v.boolean(),
  openai: v.boolean(),
})

export const runtimeSelectionStatusValidator = v.union(
  v.literal("off"),
  v.literal("legacy-openrouter"),
  v.literal("ready"),
  v.literal("selected-unavailable")
)

export const runtimeStatusValidator = v.object({
  selectedProvider: runtimeSelectedProviderValidator,
  status: runtimeSelectionStatusValidator,
  availability: runtimeProviderAvailabilityValidator,
})

// Runtime-visible profile keys only. `vision-spec` and `renderer-jsx` moved to
// the build lane on 2026-07-14 (ADR-0032 amendment) and are no longer routable
// from the Production AI surface — they live only in the shared `TASK_PROFILES`
// contract, which the local API/CLI engines still consume.
export const taskProfileValidator = v.union(
  v.literal("mechanical-translation"),
  v.literal("brand-translation"),
  v.literal("editorial-copy"),
  v.literal("structured-outline-meta"),
  v.literal("grounded-help"),
  v.literal("judgment-transform"),
  v.literal("explicit-agentic-rescue")
)

export const reasoningEffortValidator = v.union(
  v.literal("none"),
  v.literal("minimal"),
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
  v.literal("xhigh"),
  v.literal("max")
)

const reasoningValidator = <E extends string>(effort: Validator<E>) =>
  v.object({ kind: v.literal("effort"), effort })

const catalogTuple = <P extends string, M extends string, E extends string>(
  provider: P,
  model: M,
  efforts: Validator<E>
) =>
  v.object({
    mode: v.literal("catalog"),
    provider: v.literal(provider),
    model: v.literal(model),
    reasoning: reasoningValidator(efforts),
  })

// OpenRouter is the BYOK provider the operator picks from freely (admin
// agency): the picker lists the full generated OpenRouter catalog, so the
// storage gate must accept ANY of those model ids at any valid effort rather
// than a hand-maintained tuple union. This is a strict superset of the old
// 5-model union, so every previously-stored selection still validates. Effort
// is optional for the few catalog models with no reasoning support; OpenRouter
// validates the exact model+effort at call time (fail-loud).
export const openRouterModelTupleValidator = v.object({
  mode: v.literal("catalog"),
  provider: v.literal("openrouter"),
  model: v.string(),
  reasoning: v.optional(reasoningValidator(reasoningEffortValidator)),
})

const openAiEfforts = v.union(
  v.literal("none"),
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
  v.literal("xhigh"),
  v.literal("max")
)
const requiredReasoningEfforts = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
  v.literal("xhigh"),
  v.literal("max")
)
export const openAiModelTupleValidator = v.union(
  catalogTuple("openai", "gpt-6.1-sol", requiredReasoningEfforts),
  catalogTuple("openai", "gpt-6-astra", requiredReasoningEfforts),
  catalogTuple("openai", "gpt-6.1-terra", openAiEfforts),
  catalogTuple("openai", "gpt-6-sol", openAiEfforts),
  catalogTuple("openai", "gpt-6-luna", openAiEfforts),
  catalogTuple("openai", "gpt-5.6-luna", openAiEfforts),
  catalogTuple("openai", "gpt-5.6-terra", openAiEfforts),
  catalogTuple("openai", "gpt-5.6-sol", openAiEfforts)
)

export const anthropicModelTupleValidator = v.union(
  catalogTuple("anthropic", "claude-sonnet-5-5", requiredReasoningEfforts),
  catalogTuple("anthropic", "claude-opus-5-5", requiredReasoningEfforts),
  catalogTuple("anthropic", "claude-haiku-5-5", requiredReasoningEfforts),
  catalogTuple("anthropic", "claude-fable-5-1", requiredReasoningEfforts),
  catalogTuple("anthropic", "claude-sonnet-5", requiredReasoningEfforts),
  catalogTuple("anthropic", "claude-opus-4-8", requiredReasoningEfforts),
  v.object({
    mode: v.literal("catalog"),
    provider: v.literal("anthropic"),
    model: v.literal("claude-haiku-4-5-20251001"),
  })
)

export const apiModelTupleValidator = v.union(
  openRouterModelTupleValidator,
  anthropicModelTupleValidator,
  openAiModelTupleValidator
)

/** Runtime compatibility only; persisted settings remain catalog-only. */
export const legacyOpenRouterModelTupleValidator = v.object({
  mode: v.literal("legacy"),
  provider: v.literal("openrouter"),
  model: v.string(),
})
export const runtimeModelTupleValidator = v.union(
  apiModelTupleValidator,
  legacyOpenRouterModelTupleValidator
)

/** Prepared assistant settings; null tuple retains the existing model chain. */
export const runtimeAssistantValidator = v.object({
  provider: runtimeApiProviderValidator,
  tuple: v.union(apiModelTupleValidator, v.null()),
  legacy: v.boolean(),
  instructions: v.string(),
})

export const providerModelSelectionsValidator = v.object({
  openrouter: v.optional(openRouterModelTupleValidator),
  anthropic: v.optional(anthropicModelTupleValidator),
  openai: v.optional(openAiModelTupleValidator),
})

/** Per-task tuples keyed by RUNTIME_TASK_PROFILES.
 *
 *  Runtime shape: `Partial<Record<TaskProfile, ApiModelTuple>>` — any subset of
 *  the 7 profile keys, each mapping to a full catalog tuple.
 *
 *  Why `v.record(v.string(), …)` and not the tighter `v.object` or literal-key
 *  `v.record`: Convex's function-export codepath emits object-validator keys
 *  as unquoted TS identifiers, so a `v.object({ "brand-translation": … })`
 *  crashes with "Identifier brand-translation has invalid character '-'". The
 *  same happens for a literal-union `v.record` because the union values are
 *  reused as identifier candidates. `v.string()` sidesteps that; the mutation
 *  handler and the resolver both restrict the accepted keys to
 *  RUNTIME_TASK_PROFILES in code. */
export const taskDefaultsValidator = v.record(
  v.string(),
  apiModelTupleValidator
)

export const assistantIdValidator = v.union(
  v.literal("writing"), v.literal("translation"), v.literal("help")
)
export const assistantSettingsValidator = v.object({
  tuple: v.optional(apiModelTupleValidator),
  instructions: v.optional(v.string()),
})
export const assistantsSettingsValidator = v.object({
  writing: v.optional(assistantSettingsValidator),
  translation: v.optional(assistantSettingsValidator),
  help: v.optional(assistantSettingsValidator),
  // Local-only fourth assistant; not an AssistantId (see SLICE_CREATOR_PROFILES).
  sliceCreator: v.optional(assistantSettingsValidator),
})
export const providerHealthStateValidator = v.union(
  v.literal("ok"), v.literal("refused"), v.literal("unreachable")
)
export const providerObservationValidator = v.object({
  provider: runtimeApiProviderValidator,
  keyFingerprint: v.string(),
  state: providerHealthStateValidator,
  observedAt: v.number(),
})
export const providerHealthValidator = providerObservationValidator.extend({
  sourceAttemptKey: v.string(),
})
const assistantModelChoiceValidator = v.object({
  model: v.string(),
  name: v.string(),
  efforts: v.array(reasoningEffortValidator),
  providerDefault: v.union(reasoningEffortValidator, v.null()),
})

export const aiSettingsStatusValidator = v.object({
  connections: v.array(v.object({
    provider: runtimeApiProviderValidator,
    envVar: v.string(),
    state: v.union(v.literal("missing"), v.literal("connected"), v.literal("refused"), v.literal("unreachable")),
    observedAt: v.optional(v.number()),
  })),
  assistants: v.array(assistantSettingsValidator.extend({
    id: assistantIdValidator,
    available: v.boolean(),
    provider: runtimeApiProviderValidator,
    ready: v.boolean(),
    effective: runtimeModelTupleValidator,
    defaults: v.object({
      anthropic: v.union(apiModelTupleValidator, v.null()),
      openrouter: v.union(apiModelTupleValidator, v.null()),
      openai: v.union(apiModelTupleValidator, v.null()),
    }),
    choices: v.object({
      anthropic: v.array(assistantModelChoiceValidator),
      openrouter: v.array(assistantModelChoiceValidator),
      openai: v.array(assistantModelChoiceValidator),
    }),
  })),
  card: v.union(
    v.object({ state: v.literal("active") }),
    v.object({ state: v.literal("refused"), provider: runtimeApiProviderValidator }),
    v.object({ state: v.literal("missing") })
  ),
})

export const aiRuntimeSettingsValidator = v.object({
  selectedProvider: v.optional(runtimeSelectedProviderValidator),
  providerDefaults: v.optional(providerModelSelectionsValidator),
  taskDefaults: v.optional(taskDefaultsValidator),
  assistants: v.optional(assistantsSettingsValidator),
})

export const workflowPhaseValidator = v.union(
  v.literal("translation"),
  v.literal("content-generation"),
  v.literal("content-refinement"),
  v.literal("page-meta"),
  v.literal("page-outline"),
  v.literal("page-fill"),
  v.literal("slice-spec"),
  v.literal("renderer-jsx"),
  v.literal("help-answer")
)

/** The shared executor performs at most two attempts; zero is valid for
 * configuration and preflight failures that never invoke a provider. */
export const aiAttemptCountValidator = v.union(
  v.literal(0),
  v.literal(1),
  v.literal(2)
)

export const aiCostSourceValidator = v.union(
  v.literal("reported"),
  v.literal("calculated"),
  v.literal("estimate")
)
export const aiAccountingProfileValidator = v.union(
  taskProfileValidator,
  v.literal("vision-spec"),
  v.literal("renderer-jsx")
)
export const aiPriceQuoteValidator = v.object({
  revision: v.string(),
  sourceUrl: v.string(),
  checkedAt: v.string(),
  endsAt: v.union(v.number(), v.null()),
  inputPerM: v.number(),
  cacheReadPerM: v.number(),
  cacheWritePerM: v.number(),
  outputPerM: v.number(),
  maxInputTokens: v.number(),
})
export const aiFullUsageValidator = v.object({
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  totalTokens: v.optional(v.number()),
  noCacheInputTokens: v.optional(v.number()),
  cacheReadTokens: v.optional(v.number()),
  cacheWriteTokens: v.optional(v.number()),
  reasoningTokens: v.optional(v.number()),
  providerCostUsd: v.optional(v.number()),
})
export const aiAttemptAdmissionRequestValidator = v.object({
  attemptKey: v.string(),
  anchorAttemptKey: v.optional(v.string()),
  runId: v.optional(v.string()),
  unitId: v.optional(v.string()),
  provider: runtimeApiProviderValidator,
  modelId: v.string(),
  lane: executionLaneValidator,
  phase: workflowPhaseValidator,
  profile: aiAccountingProfileValidator,
  inputTokens: v.number(),
  imageTokens: v.number(),
  maxOutputTokens: v.number(),
})
export const aiAttemptAdmissionValidator = v.object({
  attemptKey: v.string(),
  admitted: v.literal(true),
  estimateMicros: v.number(),
  priceRevision: v.string(),
})
export const aiAttemptSettlementValidator = v.object({
  attemptKey: v.string(),
  outcome: v.union(
    v.literal("completed"),
    v.literal("failed"),
    v.literal("not-called")
  ),
  usage: v.optional(aiFullUsageValidator),
})
export const aiAttemptReceiptValidator = v.object({
  attemptKey: v.string(),
  chargedMicros: v.number(),
  currency: v.literal("USD"),
  costSource: aiCostSourceValidator,
})
