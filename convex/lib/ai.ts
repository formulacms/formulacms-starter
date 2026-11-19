import { accountingOperation } from "../../lib/ai/accounting-contract"
import type { GenerationAccounting } from "../../lib/ai/accounting-contract"
import type { Doc } from "../_generated/dataModel"
import type { ActionCtx, QueryCtx, MutationCtx } from "../_generated/server"
import {
  readModuleState,
  resolveOptionalModuleGuardState,
  type ModuleReadinessState,
} from "./modules/state"
import {
  resolveAssistantInstructions,
  ASSISTANT_IDS,
  ASSISTANT_PROFILES,
  assistantForProfile,
  type AssistantId,
  prependAssistantInstructions,
  validateApiModelTuple,
  tupleSupportsTaskProfile,
} from "../../lib/ai/task-profiles"
import type { Infer } from "convex/values"
import type { aiRuntimeSettingsValidator, runtimeAssistantValidator } from "./aiValidators"
import { hashOwnerClaim } from "./ownerClaim"
import type { ModelCatalog } from "../../lib/ai/model-catalog"
import {
  AI_CONNECTION_ORDER,
  hasLegacyModelConfigured,
  resolveAssistantConfiguration,
  type AiSettingsStatus,
  type AiSettingsConfiguration,
} from "./aiConfig"
import { internal } from "../_generated/api"
import { ConvexError, type Value } from "convex/values"
import { env } from "../_generated/server"
import { createAnthropicGenerationAdapter } from "../../lib/ai/adapters/anthropic-api"
import { createOpenAIGenerationAdapter } from "../../lib/ai/adapters/openai-api"
import { createOpenRouterGenerationAdapter } from "../../lib/ai/adapters/openrouter-api"
import {
  GenerationError,
  type ApiGenerationAdapter,
  type ApiModelTuple,
  type ApiProvider,
  type GenerationContentPart,
  type GenerationMessage,
  type GenerationResult,
  type SafeGenerationError,
  type TaskProfile,
  type WorkflowPhase,
} from "../../lib/ai/execution-contract"
import {
  executeGeneration,
  makeGenerationError,
  RUNTIME_GENERATION_CEILING_MS,
  type ProviderAttemptSettlement,
} from "../../lib/ai/execute-generation"
import {
  resolveRuntimeSelection,
  resolveRuntimeTuple,
  savedRuntimeSelection,
  type ProviderModelSelections,
  type RuntimeProviderAvailability,
  type RuntimeSelectedProvider,
  type TaskDefaults,
} from "./aiConfig"

export const AI_PROVIDER_ENV = {
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
} as const

export function runtimeProviderKey(provider: ApiProvider): string | undefined {
  return env[AI_PROVIDER_ENV[provider]]?.trim() || undefined
}

/** Current credentials and their fingerprint-matched health, within the caller's transaction. */
export async function readRuntimeProviderConnection(
  ctx: QueryCtx | MutationCtx,
  provider: ApiProvider
): Promise<AiSettingsStatus["connections"][number]> {
  const envVar = AI_PROVIDER_ENV[provider]
  const key = runtimeProviderKey(provider)
  if (!key) return { provider, envVar, state: "missing" }
  const fingerprint = await hashOwnerClaim(key)
  const health = await ctx.db
    .query("aiProviderHealth")
    .withIndex("by_provider", (q) => q.eq("provider", provider))
    .unique()
  if (!health || health.keyFingerprint !== fingerprint) {
    return { provider, envVar, state: "connected" }
  }
  return {
    provider,
    envVar,
    state: health.state === "ok" ? "connected" : health.state,
    observedAt: health.observedAt,
  }
}

/** No module-state read here: the caller supplies its already-read enabled ids. */
export async function resolveAiSettingsStatus(
  ctx: QueryCtx | MutationCtx,
  enabledModuleIds: ReadonlySet<string>
): Promise<AiSettingsConfiguration> {
  const settings = await ctx.db.query("siteSettings").first()
  const connections = await Promise.all(
    AI_CONNECTION_ORDER.map((provider) => readRuntimeProviderConnection(ctx, provider))
  )
  return resolveAssistantConfiguration(
    settings?.aiRuntime,
    connections,
    enabledModuleIds,
    await readLegacyModelAssistants(ctx, settings)
  )
}

const ASSISTANT_AGENT = {
  writing: "content",
  translation: "translation",
  help: "help-assistant",
} as const satisfies Record<AssistantId, string>

/** Assistants for which the owner configured a legacy OpenRouter model: an
 * agent model, the site default model, or the Convex env `CMS_AI_MODEL`. */
export async function readLegacyModelAssistants(
  ctx: QueryCtx | MutationCtx,
  settings: Pick<Doc<"siteSettings">, "aiDefaultModel" | "aiRuntime"> | null | undefined
): Promise<ReadonlySet<AssistantId>> {
  const configured = new Set<AssistantId>()
  // The legacy branch needs no saved selection and an OpenRouter key; skip the
  // agent reads everywhere else so those paths read exactly what they did.
  if (settings?.aiRuntime?.selectedProvider !== undefined ||
      !runtimeProviderKey("openrouter")) return configured
  for (const id of ASSISTANT_IDS) {
    const agentConfig = await ctx.db
      .query("agentConfigs")
      .withIndex("by_agent", (q) => q.eq("agent", ASSISTANT_AGENT[id]))
      .unique()
    if (hasLegacyModelConfigured(agentConfig?.model, settings?.aiDefaultModel)) {
      configured.add(id)
    }
  }
  return configured
}

export type RuntimeAssistant = Infer<typeof runtimeAssistantValidator>

/** Shared task composition: AI readiness never depends on Multilingual. */
export async function requireAiTranslationModule(
  ctx: QueryCtx | MutationCtx
): Promise<void> {
  const guard = await resolveOptionalModuleGuardState(ctx, "multilingual")
  if (!guard.effective || guard.readiness !== "ready") {
    throw new ConvexError("CMS_MODULE_NOT_READY")
  }
}

/**
 * Writing and Translation can be set to run on the owner's local tool
 * (`aiRuntime.assistants.<id>.localTool`, ADR-0057 decision 2). While the
 * marker is set, every API-key run of that assistant is refused, so a stale
 * tab or another device cannot spend API money the owner turned off.
 */
export async function assertAssistantNotOnLocalTool(
  ctx: QueryCtx | MutationCtx,
  assistant: "writing" | "translation"
): Promise<void> {
  const settings = await ctx.db.query("siteSettings").first()
  if (settings?.aiRuntime?.assistants?.[assistant]?.localTool === true) {
    throw new ConvexError("AI_ASSISTANT_RUNS_ON_LOCAL_TOOL")
  }
}

/** Call only after the owner/module gate, in the same prepare transaction. */
export async function resolveRuntimeAssistant(
  ctx: QueryCtx | MutationCtx,
  profile: TaskProfile,
  phase: WorkflowPhase
): Promise<RuntimeAssistant> {
  const id = assistantForProfile(profile)
  if (!id) throw new Error("No assistant owns this task profile.")
  if (id === "writing" || id === "translation") {
    await assertAssistantNotOnLocalTool(ctx, id)
  }
  const { enabledModuleIds } = await readModuleState(ctx)
  const status = await resolveAiSettingsStatus(ctx, enabledModuleIds)
  const assistant = status.assistants.find((entry) => entry.id === id)!
  if (!assistant.available) throw new ConvexError("CMS_MODULE_NOT_READY")
  if (!assistant.ready) {
    const refused = status.connections.some(
      (connection) =>
        connection.provider === assistant.provider &&
        connection.state === "refused"
    )
    const error: SafeGenerationError = {
      category: refused ? "AUTH_REQUIRED" : "CONFIG_MISSING",
      message: refused
        ? "The assistant's connection was refused."
        : "The assistant's connection is not configured.",
      selected: {
        lane: "runtime",
        provider: assistant.provider,
        model: assistant.tuple?.model ?? "",
      },
      attempts: 0,
      phase,
      retryable: false,
      nextAction: refused ? "authenticate-provider" : "configure-provider",
    }
    throw new ConvexError(error as unknown as Value)
  }
  const settings = await ctx.db.query("siteSettings").first()
  return composeRuntimeAssistant(
    settings?.aiRuntime,
    assistant,
    Boolean(runtimeProviderKey("openrouter")),
    (await readLegacyModelAssistants(ctx, settings)).has(
      assistant.id
    )
  )
}

/** Pure preparation shared by status, including missing/refused connections. */
export function composeRuntimeAssistant(
  runtime: Infer<typeof aiRuntimeSettingsValidator> | undefined,
  assistant: AiSettingsConfiguration["assistants"][number],
  hasOpenRouterKey: boolean,
  legacyModelConfigured: boolean
): RuntimeAssistant {
  return {
    provider: assistant.provider,
    tuple: runtime?.assistants?.[assistant.id]?.tuple ?? null,
    legacy:
      runtime?.selectedProvider === undefined &&
      assistant.provider === "openrouter" &&
      hasOpenRouterKey &&
      legacyModelConfigured,
    instructions: resolveAssistantInstructions(
      assistant.id,
      assistant.instructions
    ),
  }
}

/** The plain refusal for a saved model that cannot serve this task. */
export function selectionRefusal(
  provider: ApiProvider,
  model: string,
  phase: WorkflowPhase
): ConvexError<Value> {
  const error: SafeGenerationError = {
    category: "UNSUPPORTED_CAPABILITY",
    message: "The assistant's model does not support this task.",
    selected: { lane: "runtime", provider, model },
    attempts: 0,
    phase,
    retryable: false,
    nextAction: "choose-supported-input",
  }
  return new ConvexError(error as unknown as Value)
}

/** One tuple decision for instant requests and page-job freezing. */
export function resolveAssistantRuntimeTuple(
  assistant: RuntimeAssistant,
  options: Pick<
    RuntimeGenerationOptions,
    "profile" | "phase" | "providerDefaults" | "taskDefaults" | "modelOverrides" | "catalog"
  > & { legacyModelId?: string; now?: number }
): Readonly<ApiModelTuple> {
  if (assistant.tuple) {
    let tuple: Readonly<ApiModelTuple> | undefined
    try {
      tuple = validateApiModelTuple(assistant.tuple, options.catalog)
    } catch {
      tuple = undefined
    }
    if (!tuple || !tupleSupportsTaskProfile(tuple, options.profile, options.catalog)) {
      throw selectionRefusal(assistant.provider, assistant.tuple.model, options.phase)
    }
    return tuple
  }
  const id = assistantForProfile(options.profile)
  return resolveRuntimeTuple({
    ...options,
    fallbackProfile: id ? ASSISTANT_PROFILES[id][0] : options.profile,
    selection: {
      selectedProvider: assistant.provider,
      effectiveProvider: assistant.provider,
      status: assistant.legacy ? "legacy-openrouter" : "ready",
      availability: runtimeProviderAvailability(),
      legacy: assistant.legacy,
    },
  }).tuple
}

export async function resolveAiModuleReadiness(
  ctx: QueryCtx | MutationCtx,
  enabledModuleIds: ReadonlySet<string>
): Promise<ModuleReadinessState> {
  const status = await resolveAiSettingsStatus(ctx, enabledModuleIds)
  return status.assistants.some((assistant) => assistant.ready)
    ? { readiness: "ready", setup: "not_required" }
    : { readiness: "needs_setup", setup: "required" }
}
export function createRuntimeAccounting(
  ctx: ActionCtx,
  authId: string,
  job?: { reservationKey: string; runId: string; unitId: string }
): GenerationAccounting {
  const attemptProviders = new Map<
    string,
    { provider: ApiProvider; keyFingerprint: string }
  >()
  return accountingOperation({
    admit: async (request) => {
      const key = runtimeProviderKey(request.provider)
      if (key)
        attemptProviders.set(request.attemptKey, {
          provider: request.provider,
          keyFingerprint: await hashOwnerClaim(key),
        })
      return ctx.runMutation(internal.cms.ai.admitRuntimeAttempt, {
        authId,
        request: job
          ? {
              ...request,
              anchorAttemptKey: job.reservationKey,
              runId: job.runId,
              unitId: job.unitId,
            }
          : request,
      })
    },
    settle: (request: ProviderAttemptSettlement) => {
      const { providerObservation, ...settlement } = request
      const identity = attemptProviders.get(request.attemptKey)
      return ctx.runMutation(internal.cms.ai.settleRuntimeAttempt, {
        ...settlement,
        ...(providerObservation && identity
          ? {
              providerObservation: { ...providerObservation, ...identity },
            }
          : {}),
      })
    },
  })
}
// Production AI composition root. Provider selection is resolved once here;
// the shared D1 runner retains preflight, retries, deadlines, cancellation,
// safe errors, usage, and selected/actual metadata semantics.

export { DEFAULT_AI_MODEL } from "./aiConfig"
export { RUNTIME_GENERATION_CEILING_MS as AI_REQUEST_TIMEOUT_MS }

export function runtimeProviderAvailability(): RuntimeProviderAvailability {
  return {
    openrouter: Boolean(env.OPENROUTER_API_KEY?.trim()),
    anthropic: Boolean(env.ANTHROPIC_API_KEY?.trim()),
    openai: Boolean(env.OPENAI_API_KEY?.trim()),
  }
}

export function createRuntimeOpenRouterAdapter() {
  const apiKey = env.OPENROUTER_API_KEY?.trim()
  if (!apiKey) return null
  return createOpenRouterGenerationAdapter({
    apiKey,
    appName: "formulacms",
    appUrl: "https://github.com/formulacms",
  })
}

export function createRuntimeAnthropicAdapter() {
  const apiKey = env.ANTHROPIC_API_KEY?.trim()
  if (!apiKey) return null
  return createAnthropicGenerationAdapter({ apiKey })
}

export function createRuntimeOpenAIAdapter() {
  const apiKey = env.OPENAI_API_KEY?.trim()
  if (!apiKey) return null
  return createOpenAIGenerationAdapter({ apiKey })
}

function runtimeAdapter(provider: ApiProvider): ApiGenerationAdapter | null {
  if (provider === "openrouter") return createRuntimeOpenRouterAdapter()
  if (provider === "anthropic") return createRuntimeAnthropicAdapter()
  return createRuntimeOpenAIAdapter()
}

type RuntimePromptInput =
  | { prompt: string; messages?: never }
  | { messages: readonly GenerationMessage[]; prompt?: never }

export type RuntimeGenerationOptions = RuntimePromptInput & {
  assistant?: RuntimeAssistant
  profile: TaskProfile
  phase: WorkflowPhase
  selectedProvider?: RuntimeSelectedProvider
  providerDefaults?: ProviderModelSelections
  taskDefaults?: TaskDefaults
  modelOverrides?: ProviderModelSelections
  /** Entries for every candidate tuple, from the same prepare transaction. */
  catalog: ModelCatalog
  instructions?: string
  system?: string
  deadlineMs?: number
  signal?: AbortSignal
}

function requiredModalities(options: RuntimeGenerationOptions) {
  const modalities = new Set<"text" | "image" | "file">(["text"])
  if (options.messages) {
    for (const message of options.messages) {
      if (!Array.isArray(message.content)) continue
      for (const part of message.content as readonly GenerationContentPart[]) {
        if (part.type !== "file") continue
        modalities.add(part.mediaType.startsWith("image/") ? "image" : "file")
      }
    }
  }
  return [...modalities]
}

function aiOffError(options: RuntimeGenerationOptions): ConvexError<Value> {
  const error: SafeGenerationError = {
    category: "AI_OFF",
    message: "AI is disabled for this deployment.",
    selected: {
      lane: "runtime",
      provider: "off",
      model: "",
    },
    attempts: 0,
    phase: options.phase,
    retryable: false,
    nextAction: "configure-provider",
  }
  return new ConvexError(error as unknown as Value)
}

/**
 * Run one Production AI generation. Persisted selection is authoritative;
 * legacy model strings are consulted only when no selection exists and the
 * OpenRouter key activates the compatibility branch.
 */
export async function generateRuntimeText(
  legacyModelId: string | undefined,
  options: RuntimeGenerationOptions,
  accounting: GenerationAccounting
): Promise<GenerationResult<string>> {
  const availability = runtimeProviderAvailability()
  // "off" is retained data, not an execution switch. The module gate owns it.
  const preference = options.selectedProvider === "off"
    ? AI_CONNECTION_ORDER.find((provider) => availability[provider]) ?? "off"
    : options.selectedProvider
  const selection = options.assistant
    ? { effectiveProvider: options.assistant.provider, status: "ready" }
    : resolveRuntimeSelection(
        preference,
        availability,
        hasLegacyModelConfigured(legacyModelId)
      )
  if (!selection.effectiveProvider) throw aiOffError(options)

  const provider = selection.effectiveProvider
  if (selection.status === "selected-unavailable") {
    const candidate = savedRuntimeSelection({ ...options, provider })?.tuple
    const error: SafeGenerationError = {
      category: "CONFIG_MISSING",
      message: "The selected Production AI provider is not configured.",
      selected: {
        lane: "runtime",
        provider,
        model: candidate?.model ?? "",
      },
      attempts: 0,
      phase: options.phase,
      retryable: false,
      nextAction: "configure-provider",
    }
    throw new ConvexError(error as unknown as Value)
  }
  let tuple
  try {
    tuple = options.assistant
      ? resolveAssistantRuntimeTuple(options.assistant, {
          ...options,
          legacyModelId,
        })
      : resolveRuntimeTuple({
          selection: resolveRuntimeSelection(
            preference,
            availability,
            hasLegacyModelConfigured(legacyModelId)
          ),
          profile: options.profile,
          legacyModelId,
          providerDefaults: options.providerDefaults,
          taskDefaults: options.taskDefaults,
          modelOverrides: options.modelOverrides,
          catalog: options.catalog,
        }).tuple
  } catch (caught) {
    if (caught instanceof ConvexError) throw caught
    const candidate =
      options.assistant?.tuple ??
      savedRuntimeSelection({ ...options, provider })?.tuple
    const error: SafeGenerationError = {
      category: "UNSUPPORTED_CAPABILITY",
      message:
        "The persisted AI model selection is not supported for this task.",
      selected: {
        lane: "runtime",
        provider,
        model: candidate?.model ?? "",
        ...(candidate && "reasoning" in candidate && candidate.reasoning
          ? { effort: candidate.reasoning.effort }
          : {}),
      },
      attempts: 0,
      phase: options.phase,
      retryable: false,
      nextAction: "choose-supported-input",
    }
    throw new ConvexError(error as unknown as Value)
  }
  const request = {
    target: { lane: "runtime", provider },
    tuple,
    profile: options.profile,
    phase: options.phase,
    instructions:
      options.instructions === undefined
        ? undefined
        : prependAssistantInstructions(
            options.assistant?.instructions,
            options.instructions
          ),
    system:
      options.system === undefined
        ? undefined
        : prependAssistantInstructions(
            options.assistant?.instructions,
            options.system
          ),
    input:
      options.prompt === undefined
        ? { messages: options.messages }
        : { prompt: options.prompt },
    requirements: {
      inputModalities: requiredModalities(options),
      structuredOutput: false,
    },
    output: { kind: "text" },
    deadlineMs: options.deadlineMs ?? RUNTIME_GENERATION_CEILING_MS,
    signal: options.signal,
    ...(tuple.mode === "catalog"
      ? { catalogEntry: options.catalog.get(tuple.provider, tuple.model) }
      : {}),
  } as const

  try {
    const adapter = runtimeAdapter(provider)
    if (!adapter) {
      throw makeGenerationError("CONFIG_MISSING", { request, attempts: 0 })
    }
    return await executeGeneration(request, adapter, accounting)
  } catch (error) {
    if (error instanceof GenerationError) {
      throw new ConvexError(error.toJSON() as unknown as Value)
    }
    throw error
  }
}
