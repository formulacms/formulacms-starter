import { DIRECT_PRICES, moneyInteger } from "../../lib/ai/price-quote"
import { ConvexError, v } from "convex/values"
import { recordPublicChange } from "../lib/language/freshness"
import { env, mutation, query } from "../_generated/server"
import { requireOwnerAndOptionalModule, readModuleState } from "../lib/modules/state"
import {
  composeRuntimeAssistant,
  resolveAiSettingsStatus,
  resolveAssistantRuntimeTuple,
  runtimeProviderKey,
} from "../lib/ai"
import { AI_CONNECTION_ORDER, type AiSettingsStatus } from "../lib/aiConfig"
import { ANTHROPIC_API_CATALOG } from "../../lib/ai/capabilities/anthropic-api"
import { OPENAI_API_CATALOG } from "../../lib/ai/capabilities/openai-api"
import { OPENROUTER_API_CATALOG } from "../../lib/ai/capabilities/openrouter-api"
import { OPENROUTER_CATALOG_MAX_MODELS } from "../../lib/ai/openrouter-catalog"
import type { Doc } from "../_generated/dataModel"
import type { MutationCtx } from "../_generated/server"
import {
  providerModelSelectionsValidator,
  runtimeSelectedProviderValidator,
  taskDefaultsValidator,
  assistantIdValidator,
  assistantSettingsValidator,
  aiSettingsStatusValidator,
} from "../lib/aiValidators"
import {
  RUNTIME_TASK_PROFILES,
  TASK_PROFILE_REQUIREMENTS,
  validateTupleForProfiles,
  ASSISTANT_PROFILES,
  SLICE_CREATOR_PROFILES,
  taskProfileTuple,
  validateApiModelTuple,
} from "../../lib/ai/task-profiles"
import type {
  ApiModelTuple,
  ApiModelCapability,
  ApiProvider,
  ReasoningEffort,
  TaskProfile,
} from "../../lib/ai/execution-contract"
import { getSingleSettings, requirePermission } from "./settings"

export const status = query({
  args: {},
  returns: aiSettingsStatusValidator,
  handler: async (ctx) => {
    await requireOwnerAndOptionalModule(ctx, "ai", { requireReady: false })
    const { enabledModuleIds } = await readModuleState(ctx)
    const configuration = await resolveAiSettingsStatus(ctx, enabledModuleIds)
    const settings = await getSingleSettings(ctx)
    const synchronized = await ctx.db.query("openRouterCatalogModels")
      .take(OPENROUTER_CATALOG_MAX_MODELS + 1)
    const models = synchronized.length <= OPENROUTER_CATALOG_MAX_MODELS ? synchronized : []
    const assistants = await Promise.all(configuration.assistants.map(async (assistant) => {
      const agent = assistant.id === "writing" ? "content"
        : assistant.id === "translation" ? "translation" : "help-assistant"
      const agentConfig = await ctx.db.query("agentConfigs")
        .withIndex("by_agent", (q) => q.eq("agent", agent)).unique()
      const profile = ASSISTANT_PROFILES[assistant.id][0]
      const savedTuple = settings?.aiRuntime?.assistants?.[assistant.id]?.tuple
      let invalidSavedTuple: Readonly<ApiModelTuple> | undefined
      if (savedTuple) {
        try {
          validateApiModelTuple(savedTuple)
        } catch {
          invalidSavedTuple = savedTuple
        }
      }
      let effective: Readonly<ApiModelTuple>
      try {
        effective = invalidSavedTuple ?? resolveAssistantRuntimeTuple(
          composeRuntimeAssistant(settings?.aiRuntime, assistant, Boolean(runtimeProviderKey("openrouter"))),
          {
            profile,
            phase: assistant.id === "translation" ? "translation"
              : assistant.id === "help" ? "help-answer" : "content-generation",
            legacyModelId: agentConfig?.model ?? settings?.aiDefaultModel ?? undefined,
            providerDefaults: settings?.aiRuntime?.providerDefaults,
            taskDefaults: settings?.aiRuntime?.taskDefaults,
            modelOverrides: agentConfig?.modelOverrides,
          }
        )
      } catch (error) {
        const capabilityRefusal = error instanceof ConvexError &&
          typeof error.data === "object" && error.data !== null &&
          "category" in error.data && error.data.category === "UNSUPPORTED_CAPABILITY"
        const persistedRefusal = error instanceof Error && !(error instanceof ConvexError) &&
          error.message === "Persisted AI model selection is incompatible with this task profile."
        if (!capabilityRefusal && !persistedRefusal) throw error
        effective = settings?.aiRuntime?.assistants?.[assistant.id]?.tuple ??
          taskProfileTuple(assistant.provider, profile)
      }
      const choices = assistantModelChoices(ASSISTANT_PROFILES[assistant.id], models)
      const defaults = assistantModelDefaults(choices, profile)
      return {
        ...assistant,
        effective,
        choices,
        defaults,
      }
    }))
    return { ...configuration, assistants }
  },
})

/** Per-provider default tuple: the bundled primary when offered, else the first offered choice. */
function assistantModelDefaults(
  choices: AiSettingsStatus["assistants"][number]["choices"],
  profile: TaskProfile
): AiSettingsStatus["assistants"][number]["defaults"] {
  const defaults: AiSettingsStatus["assistants"][number]["defaults"] = {
    anthropic: null, openrouter: null, openai: null,
  }
  for (const provider of AI_CONNECTION_ORDER) {
    const primary = taskProfileTuple(provider, profile)
    const effort = "reasoning" in primary ? primary.reasoning?.effort : undefined
    const offered = choices[provider].some((choice) => choice.model === primary.model &&
      (effort === undefined ? choice.efforts.length === 0 : choice.efforts.includes(effort)))
    if (offered) {
      defaults[provider] = primary
    } else {
      const first = choices[provider][0]
      if (!first) continue
      const fallbackEffort = first.providerDefault !== null && first.efforts.includes(first.providerDefault)
        ? first.providerDefault : first.efforts[0]
      defaults[provider] = {
        mode: "catalog", provider, model: first.model,
        ...(fallbackEffort ? { reasoning: { kind: "effort", effort: fallbackEffort } } : {}),
      } as Exclude<ApiModelTuple, { mode: "legacy" }>
    }
  }
  return defaults
}

const assistantStatusFields = aiSettingsStatusValidator.fields.assistants.element.fields

/** The local-only Slice creator's saved model and instructions, with what it may offer.
 *  Owner-only. It returns no key, no connection state and no readiness. */
export const sliceCreator = query({
  args: {},
  returns: assistantSettingsValidator.extend({
    choices: assistantStatusFields.choices,
    defaults: assistantStatusFields.defaults,
  }),
  handler: async (ctx) => {
    await requireOwnerAndOptionalModule(ctx, "ai", { requireReady: false })
    const settings = await getSingleSettings(ctx)
    const synchronized = await ctx.db.query("openRouterCatalogModels")
      .take(OPENROUTER_CATALOG_MAX_MODELS + 1)
    const models = synchronized.length <= OPENROUTER_CATALOG_MAX_MODELS ? synchronized : []
    const choices = assistantModelChoices(SLICE_CREATOR_PROFILES, models)
    const saved = settings?.aiRuntime?.assistants?.sliceCreator
    return {
      ...(saved?.tuple ? { tuple: saved.tuple } : {}),
      ...(saved?.instructions !== undefined ? { instructions: saved.instructions } : {}),
      choices,
      defaults: assistantModelDefaults(choices, SLICE_CREATOR_PROFILES[0]),
    }
  },
})

export const setAssistant = mutation({
  args: { id: assistantIdValidator, ...assistantSettingsValidator.fields },
  returns: v.null(),
  handler: async (ctx, { id, tuple, instructions }) => {
    await requireOwnerAndOptionalModule(ctx, "ai", { requireReady: false })
    await saveAssistantSettings(ctx, id, ASSISTANT_PROFILES[id], { tuple, instructions })
    await recordPublicChange(ctx, { scopes: [] })
    return null
  },
})

/** Owner-only save for the Slice creator; the other assistants' entries stay untouched. */
export const setSliceCreator = mutation({
  args: { ...assistantSettingsValidator.fields },
  returns: v.null(),
  handler: async (ctx, { tuple, instructions }) => {
    await requireOwnerAndOptionalModule(ctx, "ai", { requireReady: false })
    await saveAssistantSettings(ctx, "sliceCreator", SLICE_CREATOR_PROFILES, { tuple, instructions })
    await recordPublicChange(ctx, { scopes: [] })
    return null
  },
})

/** Validates one assistant entry and replaces it inside `aiRuntime.assistants`. */
async function saveAssistantSettings(
  ctx: MutationCtx,
  key: keyof NonNullable<NonNullable<Doc<"siteSettings">["aiRuntime"]>["assistants"]>,
  profiles: readonly TaskProfile[],
  { tuple, instructions }: { tuple?: Readonly<ApiModelTuple>; instructions?: string }
): Promise<void> {
  if (instructions !== undefined && instructions.length > 4_000) {
    throw new ConvexError("AI_ASSISTANT_INSTRUCTIONS_TOO_LONG")
  }
  if (tuple) {
    try {
      await validateTupleForActiveCatalog(ctx, tuple, profiles)
    } catch {
      throw new ConvexError("INVALID_AI_ASSISTANT_SELECTION")
    }
  }
  const settings = await getSingleSettings(ctx)
  if (!settings) throw new ConvexError("AI_SETTINGS_NOT_INITIALIZED")
  await ctx.db.patch("siteSettings", settings._id, {
    aiRuntime: {
      ...settings.aiRuntime,
      assistants: {
        ...settings.aiRuntime?.assistants,
        [key]: { ...(tuple ? { tuple } : {}), ...(instructions !== undefined ? { instructions } : {}) },
      },
    },
    updatedAt: Date.now(),
  })
}

async function validateTupleForActiveCatalog(
  ctx: MutationCtx,
  tuple: Readonly<ApiModelTuple>,
  profiles: readonly TaskProfile[]
): Promise<void> {
  if (tuple.provider !== "openrouter" || tuple.mode !== "catalog") {
    validateTupleForProfiles(tuple, profiles)
    return
  }
  const synchronized = await ctx.db
    .query("openRouterCatalogModels")
    .withIndex("by_modelId", (q) => q.eq("modelId", tuple.model))
    .unique()
  validateTupleForCatalogModel(tuple, profiles, synchronized ?? undefined)
}

function validateTupleForCatalogModel(
  tuple: Readonly<ApiModelTuple>,
  profiles: readonly TaskProfile[],
  synchronized?: Doc<"openRouterCatalogModels">
): void {
  if (!synchronized) {
    validateTupleForProfiles(tuple, profiles)
    return
  }

  const effort: ReasoningEffort | null =
    "reasoning" in tuple && tuple.reasoning ? tuple.reasoning.effort : null
  const supportedEfforts = new Set(synchronized.reasoningEfforts)
  if (
    (synchronized.reasoningEfforts.length === 0 && effort !== null) ||
    (synchronized.reasoningEfforts.length > 0 &&
      (effort === null || !supportedEfforts.has(effort)))
  ) {
    throw new Error("The selected OpenRouter reasoning effort is unavailable.")
  }

  const inputModalities = new Set(synchronized.inputModalities)
  for (const profile of profiles) {
    const requirements = TASK_PROFILE_REQUIREMENTS[profile]
    if (
      !requirements.inputModalities.every((modality) =>
        inputModalities.has(modality)
      ) ||
      (requirements.structuredOutput && !synchronized.structuredOutput) ||
      (profile === "mechanical-translation" && effort !== "high") ||
      ((profile === "vision-spec" || profile === "renderer-jsx") &&
        effort !== "high")
    ) {
      throw new Error(
        "The selected OpenRouter model does not support this workflow."
      )
    }
  }
}

/** Offer only tuples accepted by both Save and every assistant runtime profile. */
function assistantModelChoices(
  profiles: readonly TaskProfile[],
  synchronized: Doc<"openRouterCatalogModels">[]
): AiSettingsStatus["assistants"][number]["choices"] {
  const synchronizedById = new Map(synchronized.map((model) => [model.modelId, model]))
  const catalogs: Record<ApiProvider, Record<string, ApiModelCapability & { readonly name: string }>> = {
    anthropic: ANTHROPIC_API_CATALOG,
    openai: OPENAI_API_CATALOG,
    openrouter: synchronized.length === 0 ? OPENROUTER_API_CATALOG : Object.fromEntries(
      synchronized.map((model) => [model.modelId, {
        name: model.name,
        inputModalities: model.inputModalities,
        outputModalities: ["text"] as const,
        structuredOutput: model.structuredOutput,
        reasoning: model.reasoningEfforts.length === 0 ? { kind: "unsupported" as const }
          : { kind: "effort" as const, supportedEfforts: model.reasoningEfforts, providerDefault: "medium" as const },
      }])
    ),
  }
  const choices: AiSettingsStatus["assistants"][number]["choices"] = {
    anthropic: [], openrouter: [], openai: [],
  }
  for (const provider of AI_CONNECTION_ORDER) {
    for (const [model, capability] of Object.entries(catalogs[provider])) {
      // A direct price with an end date stops admission on that date; a saved
      // tuple keeps working until then, but the model is no longer offered.
      if (provider !== "openrouter" && DIRECT_PRICES[`${provider}:${model}`]?.endsAt != null) continue
      const supports = (effort: ReasoningEffort | null) => {
        const tuple = { mode: "catalog", provider, model,
          ...(effort === null ? {} : { reasoning: { kind: "effort", effort } }),
        } as ApiModelTuple
        try {
          validateTupleForCatalogModel(tuple, profiles, provider === "openrouter" ? synchronizedById.get(model) : undefined)
          validateTupleForProfiles(tuple, profiles)
          return true
        } catch {
          return false
        }
      }
      const efforts = capability.reasoning.kind === "effort"
        ? capability.reasoning.supportedEfforts.filter(supports) : []
      if (efforts.length === 0 && (capability.reasoning.kind !== "unsupported" || !supports(null))) continue
      choices[provider].push({
        model, name: capability.name, efforts,
        providerDefault: capability.reasoning.kind === "effort" ? capability.reasoning.providerDefault : null,
      })
    }
  }
  return choices
}

export const setProductionAiConfiguration = mutation({
  args: {
    selectedProvider: runtimeSelectedProviderValidator,
    providerDefaults: providerModelSelectionsValidator,
    taskDefaults: v.optional(taskDefaultsValidator),
  },
  returns: v.null(),
  handler: async (
    ctx,
    { selectedProvider, providerDefaults, taskDefaults }
  ) => {
    await requireOwnerAndOptionalModule(ctx, "ai", { requireReady: false })
    await requirePermission(ctx, "settings:update")
    const existing = await getSingleSettings(ctx)
    if (!existing) {
      throw new ConvexError("Site settings not initialized yet.")
    }

    const available =
      selectedProvider === "off" ||
      (selectedProvider === "openrouter" &&
        Boolean(env.OPENROUTER_API_KEY?.trim())) ||
      (selectedProvider === "anthropic" &&
        Boolean(env.ANTHROPIC_API_KEY?.trim())) ||
      (selectedProvider === "openai" && Boolean(env.OPENAI_API_KEY?.trim()))
    const unchanged = existing.aiRuntime?.selectedProvider === selectedProvider
    if (!available && !unchanged) {
      throw new ConvexError(
        "PROVIDER_UNAVAILABLE: Configure the selected Production AI provider before activating it."
      )
    }

    await Promise.all(
      Object.entries(providerDefaults).map(async ([provider, tuple]) => {
        if (!tuple) return
        if (tuple.provider !== provider) {
          throw new ConvexError(
            "INVALID_AI_SELECTION: Provider tuple mismatch."
          )
        }
        try {
          await validateTupleForActiveCatalog(ctx, tuple, RUNTIME_TASK_PROFILES)
        } catch {
          throw new ConvexError(
            "INVALID_AI_SELECTION: A site default must support every Production AI workflow."
          )
        }
      })
    )

    // Task defaults are per-profile: each tuple must belong to the selected
    // provider AND support that one profile. AI off => no task defaults can
    // stand (nothing to route). Empty/missing is fine — it means "no per-task
    // overrides" and skips validation entirely.
    const hasTaskDefaults =
      taskDefaults !== undefined &&
      Object.values(taskDefaults).some((tuple) => tuple !== undefined)
    if (hasTaskDefaults && selectedProvider === "off") {
      throw new ConvexError(
        "INVALID_AI_SELECTION: Task defaults require an active provider."
      )
    }
    if (hasTaskDefaults && taskDefaults) {
      const runtimeProfiles = new Set<string>(RUNTIME_TASK_PROFILES)
      await Promise.all(
        Object.entries(taskDefaults).map(async ([profile, tuple]) => {
          if (!tuple) return
          // The validator accepts any string key (v.record's identifier-export
          // limitation forces us wide); reject unknown profiles here.
          if (!runtimeProfiles.has(profile)) {
            throw new ConvexError(
              "INVALID_AI_SELECTION: Unknown task profile in task defaults."
            )
          }
          if (tuple.provider !== selectedProvider) {
            throw new ConvexError(
              "INVALID_AI_SELECTION: A task default must use the selected provider."
            )
          }
          try {
            await validateTupleForActiveCatalog(ctx, tuple, [
              profile as TaskProfile,
            ])
          } catch {
            throw new ConvexError(
              "INVALID_AI_SELECTION: A task default must support its own workflow."
            )
          }
        })
      )
    }

    const nextTaskDefaults = hasTaskDefaults ? taskDefaults : undefined
    const configurationUnchanged =
      unchanged &&
      JSON.stringify(existing.aiRuntime?.providerDefaults ?? {}) ===
        JSON.stringify(providerDefaults) &&
      JSON.stringify(existing.aiRuntime?.taskDefaults ?? {}) ===
        JSON.stringify(nextTaskDefaults ?? {})
    if (!configurationUnchanged) {
      await ctx.db.patch("siteSettings", existing._id, {
        aiRuntime: {
          ...(existing.aiRuntime?.assistants ? { assistants: existing.aiRuntime.assistants } : {}),
          selectedProvider,
          providerDefaults,
          ...(nextTaskDefaults ? { taskDefaults: nextTaskDefaults } : {}),
        },
        updatedAt: Date.now(),
      })
      // F09 invariant 6: every siteSettings write, public or not.
      await recordPublicChange(ctx, { scopes: [] })
    }
    return null
  },
})

export const setMonthlyAiCap = mutation({
  args: { capMicros: v.number() },
  returns: v.null(),
  handler: async (ctx, { capMicros }) => {
    await requireOwnerAndOptionalModule(ctx, "ai", { requireReady: false })
    moneyInteger(capMicros)
    const settings = await getSingleSettings(ctx)
    if (!settings) throw new ConvexError("Site settings not initialized yet.")
    await ctx.db.patch("siteSettings", settings._id, {
      aiMonthlyCapMicros: capMicros,
    })
    return null
  },
})
