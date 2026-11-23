import { nextUpdatedAt } from "../lib/versions"
import { ConvexError, v } from "convex/values"
import { recordPublicChange } from "../lib/language/freshness"
import { env, mutation, query } from "../_generated/server"
import { requireOwnerAndOptionalModule, resolveOptionalModuleGuardState, readModuleState } from "../lib/modules/state"
import { requireOperationAccess } from "../lib/access/policy"
import {
  composeRuntimeAssistant,
  resolveAiSettingsStatus,
  resolveAssistantRuntimeTuple,
  runtimeProviderKey,
} from "../lib/ai"
import {
  hasLegacyModelConfigured,
  savedRuntimeSelection,
  type AiSettingsStatus,
} from "../lib/aiConfig"
import {
  assertTupleSelectable,
  catalogModelEntryValidator,
  loadProviderCatalog,
  loadRuntimeCatalogEntries,
} from "../lib/aiCatalog"
import { readSyncState } from "../lib/catalogRefresh"
import { KEY_REFUSED_MESSAGE } from "./vendorModelCatalog"
import type { Doc } from "../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../_generated/server"
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
  ASSISTANT_PROFILES,
  assistantModelChoices,
  defaultTupleFor,
  BLOCK_CREATOR_PROFILES,
  taskProfileTuple,
  tupleSupportsTaskProfile,
  validateApiModelTuple,
} from "../../lib/ai/task-profiles"
import {
  catalogFromEntries,
  newerModelFor,
  type ModelCatalog,
} from "../../lib/ai/model-catalog"
import {
  API_PROVIDERS,
  type ApiModelTuple,
  type TaskProfile,
} from "../../lib/ai/execution-contract"
import { getSingleSettings } from "./settings"

/** The time a Settings read checks retirement and price end dates against.
 * The screen passes none; tests pass a fixed value. */
function settingsNow(now: number | undefined): number {
  return now ?? Date.now()
}

/** One shared catalog for a whole Settings read: one bounded load per provider. */
async function loadSettingsCatalog(ctx: QueryCtx): Promise<ModelCatalog> {
  const entries = await Promise.all(
    API_PROVIDERS.map((provider) => loadProviderCatalog(ctx, provider))
  )
  return catalogFromEntries(entries.flat())
}

async function readCatalogSync(ctx: QueryCtx) {
  const status = async (provider: (typeof API_PROVIDERS)[number]) => {
    const state = await readSyncState(ctx, provider)
    return {
      status: state?.status ?? ("never" as const),
      ...(state?.lastSuccessAt === undefined ? {} : { lastSuccessAt: state.lastSuccessAt }),
      keyRefused: state?.error === KEY_REFUSED_MESSAGE,
    }
  }
  return {
    anthropic: await status("anthropic"),
    openrouter: await status("openrouter"),
    openai: await status("openai"),
  }
}

export const status = query({
  args: { now: v.optional(v.number()) },
  returns: v.union(aiSettingsStatusValidator, v.null()),
  handler: async (ctx, args): Promise<AiSettingsStatus | null> => {
    // Owner first, as every AI entry point. While the AI module is off this
    // returns null instead of throwing: Convex re-runs open subscriptions in
    // the same transition that turns AI off, before the client learns it.
    await requireOperationAccess(ctx)
    const guard = await resolveOptionalModuleGuardState(ctx, "ai")
    if (!guard.effective) return null
    const now = settingsNow(args.now)
    const { enabledModuleIds } = await readModuleState(ctx)
    const configuration = await resolveAiSettingsStatus(ctx, enabledModuleIds)
    const settings = await getSingleSettings(ctx)
    const catalog = await loadSettingsCatalog(ctx)
    const assistants = await Promise.all(configuration.assistants.map(async (assistant) => {
      const agent = assistant.id === "writing" ? "content"
        : assistant.id === "translation" ? "translation" : "help-assistant"
      const agentConfig = await ctx.db.query("agentConfigs")
        .withIndex("by_agent", (q) => q.eq("agent", agent)).unique()
      const profile = ASSISTANT_PROFILES[assistant.id][0]
      const runtimeAssistant = composeRuntimeAssistant(
        settings?.aiRuntime,
        assistant,
        Boolean(runtimeProviderKey("openrouter")),
        hasLegacyModelConfigured(agentConfig?.model, settings?.aiDefaultModel)
      )
      // The saved selection a run uses, found once with the run's precedence:
      // the assistant's own tuple, else (off the legacy branch) the agent
      // override, the task default or the site default.
      const persisted = settings?.aiRuntime?.assistants?.[assistant.id]?.tuple ??
        (runtimeAssistant.legacy ? undefined : savedRuntimeSelection({
          provider: assistant.provider,
          profile,
          providerDefaults: settings?.aiRuntime?.providerDefaults,
          taskDefaults: settings?.aiRuntime?.taskDefaults,
          modelOverrides: agentConfig?.modelOverrides,
        })?.tuple)
      let effective: Readonly<ApiModelTuple>
      try {
        // A saved selection the catalog no longer accepts for this task
        // (removed, unknown capabilities, wrong effort) is shown as saved and
        // not offered; a run refuses it. Retired or unpriced ones pass this
        // check, show the same way, and are refused at admission.
        effective = persisted && !servesProfile(persisted, profile, catalog)
          ? persisted
          : resolveAssistantRuntimeTuple(runtimeAssistant, {
              profile,
              phase: assistant.id === "translation" ? "translation"
                : assistant.id === "help" ? "help-answer" : "content-generation",
              legacyModelId: agentConfig?.model ?? settings?.aiDefaultModel ?? undefined,
              providerDefaults: settings?.aiRuntime?.providerDefaults,
              taskDefaults: settings?.aiRuntime?.taskDefaults,
              modelOverrides: agentConfig?.modelOverrides,
              catalog,
              now,
            })
      } catch (error) {
        const capabilityRefusal = error instanceof ConvexError &&
          typeof error.data === "object" && error.data !== null &&
          "category" in error.data && error.data.category === "UNSUPPORTED_CAPABILITY"
        const persistedRefusal = error instanceof Error && !(error instanceof ConvexError) &&
          error.message === "Persisted AI model selection is incompatible with this task profile."
        if (!capabilityRefusal && !persistedRefusal) throw error
        effective = persisted ?? taskProfileTuple(assistant.provider, profile)
      }
      const choices = assistantModelChoices(ASSISTANT_PROFILES[assistant.id], catalog, now)
      const defaults = assistantModelDefaults(choices, profile)
      const effectiveEntry = effective.mode === "catalog"
        ? catalog.get(effective.provider, effective.model) : undefined
      const newer = effectiveEntry && newerModelFor(effectiveEntry, catalog, now)
      return {
        ...assistant,
        effective,
        choices,
        defaults,
        ...(newer ? { newerModel: { provider: newer.provider, model: newer.model, name: newer.name } } : {}),
      }
    }))
    return { ...configuration, assistants, catalogSync: await readCatalogSync(ctx) }
  },
})

/** Whether a saved tuple is a valid catalog tuple that serves `profile`. */
function servesProfile(
  tuple: Readonly<ApiModelTuple>,
  profile: TaskProfile,
  catalog: ModelCatalog
): boolean {
  try {
    return tupleSupportsTaskProfile(validateApiModelTuple(tuple, catalog), profile, catalog)
  } catch {
    return false
  }
}

/** Per-provider default tuple: the one rule shared with every run. */
function assistantModelDefaults(
  choices: AiSettingsStatus["assistants"][number]["choices"],
  profile: TaskProfile
): AiSettingsStatus["assistants"][number]["defaults"] {
  return {
    anthropic: defaultTupleFor("anthropic", profile, choices.anthropic),
    openrouter: defaultTupleFor("openrouter", profile, choices.openrouter),
    openai: defaultTupleFor("openai", profile, choices.openai),
  }
}

const assistantStatusFields = aiSettingsStatusValidator.fields.assistants.element.fields

/** The local-only Block creator's saved model and instructions, with what it may offer.
 *  Owner-only. It returns no key, no connection state and no readiness. */
export const blockCreator = query({
  args: { now: v.optional(v.number()) },
  returns: assistantSettingsValidator.extend({
    choices: assistantStatusFields.choices,
    defaults: assistantStatusFields.defaults,
    /** Entries for the saved tuple and each provider's committed defaults:
     *  the local run checks its tuple against these (lane picks the provider). */
    catalog: v.array(catalogModelEntryValidator),
    /** For the saved tuple and each provider's default: its newer catalog model.
     *  The card shows the one for the tuple it shows. */
    newerModels: v.array(v.object({
      for: v.object({ provider: v.string(), model: v.string() }),
      provider: v.string(),
      model: v.string(),
      name: v.string(),
    })),
  }),
  handler: async (ctx, args) => {
    await requireOwnerAndOptionalModule(ctx, "ai", { requireReady: false })
    const settings = await getSingleSettings(ctx)
    const now = settingsNow(args.now)
    const modelCatalog = await loadSettingsCatalog(ctx)
    const choices = assistantModelChoices(BLOCK_CREATOR_PROFILES, modelCatalog, now)
    const saved = settings?.aiRuntime?.assistants?.blockCreator
    const defaults = assistantModelDefaults(choices, BLOCK_CREATOR_PROFILES[0])
    const newerModels: Array<{
      for: { provider: string; model: string }
      provider: string
      model: string
      name: string
    }> = []
    for (const tuple of [saved?.tuple, ...API_PROVIDERS.map((provider) => defaults[provider])]) {
      if (tuple?.mode !== "catalog") continue
      if (newerModels.some((entry) => entry.for.provider === tuple.provider && entry.for.model === tuple.model)) continue
      const entry = modelCatalog.get(tuple.provider, tuple.model)
      const newer = entry && newerModelFor(entry, modelCatalog, now)
      if (newer) newerModels.push({ for: { provider: tuple.provider, model: tuple.model }, provider: newer.provider, model: newer.model, name: newer.name })
    }
    return {
      ...(saved?.tuple ? { tuple: saved.tuple } : {}),
      ...(saved?.instructions !== undefined ? { instructions: saved.instructions } : {}),
      choices,
      defaults,
      catalog: await loadRuntimeCatalogEntries(ctx, {
        providers: API_PROVIDERS,
        profiles: BLOCK_CREATOR_PROFILES,
        tuples: [saved?.tuple],
        now,
      }),
      newerModels,
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

/**
 * Owner-only: marks Writing or Translation as run on the owner's local tool, or
 * clears the mark. While marked, Convex refuses every API-key run of that
 * assistant (`AI_ASSISTANT_RUNS_ON_LOCAL_TOOL`). The saved model and
 * Instructions stay untouched.
 */
export const setAssistantLocalTool = mutation({
  args: {
    assistant: v.union(v.literal("writing"), v.literal("translation")),
    on: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, { assistant, on }) => {
    await requireOwnerAndOptionalModule(ctx, "ai", { requireReady: false })
    const settings = await getSingleSettings(ctx)
    if (!settings) throw new ConvexError("AI_SETTINGS_NOT_INITIALIZED")
    const current = settings.aiRuntime?.assistants?.[assistant]
    await ctx.db.patch("siteSettings", settings._id, {
      aiRuntime: {
        ...settings.aiRuntime,
        assistants: {
          ...settings.aiRuntime?.assistants,
          [assistant]: {
            ...(current?.tuple ? { tuple: current.tuple } : {}),
            ...(current?.instructions !== undefined
              ? { instructions: current.instructions }
              : {}),
            ...(on ? { localTool: true as const } : {}),
          },
        },
      },
      updatedAt: nextUpdatedAt(settings.updatedAt, Date.now()),
    })
    await recordPublicChange(ctx, { scopes: [] })
    return null
  },
})

/** Owner-only save for the Block creator; the other assistants' entries stay untouched. */
export const setBlockCreator = mutation({
  args: { ...assistantSettingsValidator.fields },
  returns: v.null(),
  handler: async (ctx, { tuple, instructions }) => {
    await requireOwnerAndOptionalModule(ctx, "ai", { requireReady: false })
    await saveAssistantSettings(ctx, "blockCreator", BLOCK_CREATOR_PROFILES, { tuple, instructions })
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
        // A model or Instructions save keeps the owner's local tool marker.
        [key]: {
          ...(tuple ? { tuple } : {}),
          ...(instructions !== undefined ? { instructions } : {}),
          ...(settings.aiRuntime?.assistants?.[key as "writing"]?.localTool === true
            ? { localTool: true as const }
            : {}),
        },
      },
    },
    updatedAt: nextUpdatedAt(settings.updatedAt, Date.now()),
  })
}

async function validateTupleForActiveCatalog(
  ctx: MutationCtx,
  tuple: Readonly<ApiModelTuple>,
  profiles: readonly TaskProfile[]
): Promise<void> {
  await assertTupleSelectable(ctx, tuple, profiles, Date.now())
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
    await requireOperationAccess(ctx)
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
        updatedAt: nextUpdatedAt(existing.updatedAt, Date.now()),
      })
      // F09 invariant 6: every siteSettings write, public or not.
      await recordPublicChange(ctx, { scopes: [] })
    }
    return null
  },
})
