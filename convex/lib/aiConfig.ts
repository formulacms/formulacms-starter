// Production AI selection helpers for Convex runtime callers.
import { env } from "../_generated/server"
import type {
  ApiModelTuple,
  ApiProvider,
  TaskProfile,
} from "../../lib/ai/execution-contract"
import {
  assistantForProfile,
  assistantModelChoices,
  createLegacyOpenRouterTuple,
  defaultTupleFor,
  taskProfileTuple,
  tupleSupportsTaskProfile,
  validateApiModelTuple,
  ASSISTANT_IDS,
  ASSISTANT_PROFILES,
  type AssistantId,
} from "../../lib/ai/task-profiles"
import type { ModelCatalog } from "../../lib/ai/model-catalog"
import type { Infer } from "convex/values"
import type { aiRuntimeSettingsValidator, aiSettingsStatusValidator } from "./aiValidators"

export const AI_CONNECTION_ORDER = ["anthropic", "openrouter", "openai"] as const
export type AiSettingsStatus = Infer<typeof aiSettingsStatusValidator>
/** Readiness stays cheap; only the settings query needs the model catalog. */
export type AiSettingsConfiguration = Omit<AiSettingsStatus, "assistants" | "catalogSync"> & {
  assistants: Omit<AiSettingsStatus["assistants"][number], "effective" | "choices" | "defaults" | "newerModel">[]
}

/** Shared authority for Settings status, readiness and execution preparation. */
export function resolveAssistantConfiguration(
  runtime: Infer<typeof aiRuntimeSettingsValidator> | undefined,
  connections: AiSettingsStatus["connections"],
  enabledModuleIds: ReadonlySet<string>,
  /** Assistants whose legacy OpenRouter model was configured by the owner. */
  legacyModelAssistants: ReadonlySet<AssistantId> = new Set()
): AiSettingsConfiguration {
  const usable = (provider: ApiProvider) => connections.some(
    (connection) => connection.provider === provider &&
      (connection.state === "connected" || connection.state === "unreachable")
  )
  const refused = (provider: ApiProvider) => connections.some(
    (connection) => connection.provider === provider && connection.state === "refused"
  )
  // Legacy selection is a preference only; an explicit assistant tuple wins.
  // The module gate owns enablement, so legacy "off" means no preference.
  const availability = {
    anthropic: connections.some((c) => c.provider === "anthropic" && c.state !== "missing"),
    openrouter: connections.some((c) => c.provider === "openrouter" && c.state !== "missing"),
    openai: connections.some((c) => c.provider === "openai" && c.state !== "missing"),
  }
  const assistants = ASSISTANT_IDS.map((id) => {
    const settings = runtime?.assistants?.[id]
    const legacy = resolveRuntimeSelection(
      runtime?.selectedProvider,
      availability,
      legacyModelAssistants.has(id)
    ).effectiveProvider
    let provider: ApiProvider = settings?.tuple?.provider ?? legacy ??
      (id === "translation" ? "openrouter" : "anthropic")
    if (!settings?.tuple && !usable(provider) && !refused(provider)) {
      provider = AI_CONNECTION_ORDER.find(usable) ?? provider
    }
    const available = id !== "translation" || enabledModuleIds.has("multilingual")
    return {
      id, available, provider,
      ready: available && usable(provider),
      tuple: settings?.tuple ?? taskProfileTuple(provider, ASSISTANT_PROFILES[id][0]),
      ...(settings?.instructions !== undefined ? { instructions: settings.instructions } : {}),
    }
  })
  const rejected = AI_CONNECTION_ORDER.find(refused)
  const card: AiSettingsStatus["card"] = assistants.some((a) => a.ready)
    ? { state: "active" }
    : rejected ? { state: "refused", provider: rejected } : { state: "missing" }
  return { connections, assistants, card }
}

export type TaskDefaults = Partial<Record<TaskProfile, Readonly<ApiModelTuple>>>

export const DEFAULT_AI_MODEL = "google/gemini-2.5-flash"

export type RuntimeSelectedProvider = ApiProvider | "off"
export type RuntimeProviderAvailability = Record<ApiProvider, boolean>
type CatalogTuple<P extends ApiProvider> = Readonly<
  Extract<ApiModelTuple, { mode: "catalog"; provider: P }>
>
export type ProviderModelSelections = {
  openrouter?: CatalogTuple<"openrouter">
  anthropic?: CatalogTuple<"anthropic">
  openai?: CatalogTuple<"openai">
}
export type RuntimeSelectionStatus =
  | "off"
  | "legacy-openrouter"
  | "ready"
  | "selected-unavailable"

export interface RuntimeSelection {
  selectedProvider: RuntimeSelectedProvider
  effectiveProvider: ApiProvider | null
  status: RuntimeSelectionStatus
  availability: RuntimeProviderAvailability
  legacy: boolean
}

export function resolveOpenRouterModelId(modelId?: string) {
  const id = modelId || env.CMS_AI_MODEL || DEFAULT_AI_MODEL
  return id.startsWith("openrouter:")
    ? id.slice("openrouter:".length)
    : id
}

/** True when the owner configured a legacy OpenRouter model: an agent model,
 * the site default model, or the Convex env `CMS_AI_MODEL`. */
export function hasLegacyModelConfigured(
  ...models: (string | null | undefined)[]
): boolean {
  return [...models, env.CMS_AI_MODEL].some((model) => Boolean(model?.trim()))
}

export function resolveRuntimeSelection(
  persistedSelection: RuntimeSelectedProvider | undefined,
  availability: RuntimeProviderAvailability,
  legacyModelConfigured = false
): RuntimeSelection {
  if (persistedSelection === undefined) {
    // An OpenRouter key alone is not a legacy choice: a model must be set.
    if (availability.openrouter && legacyModelConfigured) {
      return {
        selectedProvider: "openrouter",
        effectiveProvider: "openrouter",
        status: "legacy-openrouter",
        availability,
        legacy: true,
      }
    }
    return {
      selectedProvider: "off",
      effectiveProvider: null,
      status: "off",
      availability,
      legacy: false,
    }
  }

  if (persistedSelection === "off") {
    return {
      selectedProvider: "off",
      effectiveProvider: null,
      status: "off",
      availability,
      legacy: false,
    }
  }

  return {
    selectedProvider: persistedSelection,
    effectiveProvider: persistedSelection,
    status: availability[persistedSelection]
      ? "ready"
      : "selected-unavailable",
    availability,
    legacy: false,
  }
}

export function isRuntimeReady(selection: RuntimeSelection): boolean {
  return selection.status === "ready" || selection.status === "legacy-openrouter"
}

export type RuntimeTupleSource =
  | "legacy"
  | "agent"
  | "task"
  | "site"
  | "catalog"

/** Nothing saved: the same default rule Settings shows (`defaultTupleFor`),
 * over the same assistant profiles and catalog entries. When the provider
 * offers nothing, the committed default stays and the checks refuse it. */
function defaultModelTuple(
  provider: ApiProvider,
  args: { profile: TaskProfile; fallbackProfile?: TaskProfile; catalog: ModelCatalog; now?: number }
): Readonly<ApiModelTuple> {
  const primary = args.fallbackProfile ?? args.profile
  // Only an assistant's runs share Settings' rule; other callers keep the
  // committed default of their own task.
  const id = args.fallbackProfile ? assistantForProfile(primary) : undefined
  if (!id) return taskProfileTuple(provider, primary)
  const profiles: readonly TaskProfile[] = ASSISTANT_PROFILES[id]
  const choices = assistantModelChoices(profiles, args.catalog, args.now ?? Date.now())
  return defaultTupleFor(provider, primary, choices[provider]) ?? taskProfileTuple(provider, primary)
}

/** The saved selection a run of `profile` on `provider` uses, with its
 * source, or undefined when nothing is saved (the default rule then applies).
 * Precedence: agent modelOverride > taskDefault (this provider only) > site
 * providerDefault. The one owner of this order: runs resolve it, Settings
 * shows it, and refusals name it. */
export function savedRuntimeSelection(args: {
  provider: ApiProvider
  profile: TaskProfile
  providerDefaults?: ProviderModelSelections
  taskDefaults?: TaskDefaults
  modelOverrides?: ProviderModelSelections
}): { tuple: Readonly<ApiModelTuple>; source: "agent" | "task" | "site" } | undefined {
  const agentOverride = args.modelOverrides?.[args.provider]
  if (agentOverride) return { tuple: agentOverride, source: "agent" }
  const taskDefault = args.taskDefaults?.[args.profile]
  if (taskDefault?.provider === args.provider) return { tuple: taskDefault, source: "task" }
  const siteDefault = args.providerDefaults?.[args.provider]
  return siteDefault ? { tuple: siteDefault, source: "site" } : undefined
}

/** Resolve one exact tuple without changing provider. Typed overrides win only
 * on the explicit D3 branch; the legacy OpenRouter model chain is unchanged.
 *
 * Precedence: agent modelOverride > taskDefault > site providerDefault >
 * committed catalog. A taskDefault for another provider is skipped; one for
 * this provider that the shared catalog no longer supports for this profile
 * is refused with a plain error, never silently replaced (design 1b risk 2). */
export function resolveRuntimeTuple(args: {
  selection: RuntimeSelection
  profile: TaskProfile
  fallbackProfile?: TaskProfile
  legacyModelId?: string
  providerDefaults?: ProviderModelSelections
  taskDefaults?: TaskDefaults
  modelOverrides?: ProviderModelSelections
  catalog: ModelCatalog
  /** Checked against retirement and price end dates; default is the clock. */
  now?: number
}): { tuple: Readonly<ApiModelTuple>; source: RuntimeTupleSource } {
  const provider = args.selection.effectiveProvider
  if (!provider) throw new Error("AI is off.")
  if (args.selection.legacy) {
    return {
      tuple: createLegacyOpenRouterTuple(
        resolveOpenRouterModelId(args.legacyModelId)
      ),
      source: "legacy",
    }
  }

  const saved = savedRuntimeSelection({ ...args, provider })
  const tuple = saved
    ? validateApiModelTuple(saved.tuple, args.catalog)
    : defaultModelTuple(provider, args)
  if (
    tuple.provider !== provider ||
    !tupleSupportsTaskProfile(tuple, args.profile, args.catalog)
  ) {
    throw new Error("Persisted AI model selection is incompatible with this task profile.")
  }
  return { tuple, source: saved?.source ?? "catalog" }
}
