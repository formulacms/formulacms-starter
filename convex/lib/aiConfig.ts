// Production AI selection helpers for Convex runtime callers.
import { env } from "../_generated/server"
import type {
  ApiModelTuple,
  ApiProvider,
  TaskProfile,
} from "../../lib/ai/execution-contract"
import {
  createLegacyOpenRouterTuple,
  taskProfileTuple,
  tupleSupportsTaskProfile,
  validateApiModelTuple,
  ASSISTANT_IDS,
  ASSISTANT_PROFILES,
} from "../../lib/ai/task-profiles"
import type { Infer } from "convex/values"
import type { aiRuntimeSettingsValidator, aiSettingsStatusValidator } from "./aiValidators"

export const AI_CONNECTION_ORDER = ["anthropic", "openrouter", "openai"] as const
export type AiSettingsStatus = Infer<typeof aiSettingsStatusValidator>
/** Readiness stays cheap; only the settings query needs the model catalog. */
export type AiSettingsConfiguration = Omit<AiSettingsStatus, "assistants"> & {
  assistants: Omit<AiSettingsStatus["assistants"][number], "effective" | "choices" | "defaults">[]
}

/** Shared authority for Settings status, readiness and execution preparation. */
export function resolveAssistantConfiguration(
  runtime: Infer<typeof aiRuntimeSettingsValidator> | undefined,
  connections: AiSettingsStatus["connections"],
  enabledModuleIds: ReadonlySet<string>
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
  const legacy = resolveRuntimeSelection(runtime?.selectedProvider, {
    anthropic: connections.some((c) => c.provider === "anthropic" && c.state !== "missing"),
    openrouter: connections.some((c) => c.provider === "openrouter" && c.state !== "missing"),
    openai: connections.some((c) => c.provider === "openai" && c.state !== "missing"),
  }).effectiveProvider
  const assistants = ASSISTANT_IDS.map((id) => {
    const settings = runtime?.assistants?.[id]
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

export function resolveRuntimeSelection(
  persistedSelection: RuntimeSelectedProvider | undefined,
  availability: RuntimeProviderAvailability
): RuntimeSelection {
  if (persistedSelection === undefined) {
    if (availability.openrouter) {
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

/** Resolve one exact tuple without changing provider. Typed overrides win only
 * on the explicit D3 branch; the legacy OpenRouter model chain is unchanged.
 *
 * Precedence: agent modelOverride > matching taskDefault > site providerDefault
 * > committed catalog. "Matching" means a taskDefault whose tuple targets the
 * effective provider AND supports this profile — a stale mismatched entry falls
 * through instead of hard-erroring generation. */
export function resolveRuntimeTuple(args: {
  selection: RuntimeSelection
  profile: TaskProfile
  fallbackProfile?: TaskProfile
  legacyModelId?: string
  providerDefaults?: ProviderModelSelections
  taskDefaults?: TaskDefaults
  modelOverrides?: ProviderModelSelections
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

  const agentOverride = args.modelOverrides?.[provider]
  const rawTaskDefault = args.taskDefaults?.[args.profile]
  const taskDefault =
    rawTaskDefault &&
    rawTaskDefault.provider === provider &&
    tupleSupportsTaskProfile(rawTaskDefault, args.profile)
      ? rawTaskDefault
      : undefined
  const siteDefault = args.providerDefaults?.[provider]

  const candidate = agentOverride ?? taskDefault ?? siteDefault
  if (!candidate) {
    const tuple = taskProfileTuple(provider, args.fallbackProfile ?? args.profile)
    if (!tupleSupportsTaskProfile(tuple, args.profile)) {
      throw new Error("Persisted AI model selection is incompatible with this task profile.")
    }
    return { tuple, source: "catalog" }
  }
  const tuple = validateApiModelTuple(candidate)
  if (tuple.provider !== provider || !tupleSupportsTaskProfile(tuple, args.profile)) {
    throw new Error("Persisted AI model selection is incompatible with this task profile.")
  }
  return {
    tuple,
    source: agentOverride ? "agent" : taskDefault ? "task" : "site",
  }
}
