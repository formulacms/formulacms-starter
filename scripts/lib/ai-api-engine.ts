import type { GenerationAccounting } from "@/lib/ai/accounting-contract"
import { readFile } from "node:fs/promises"
import { createAnthropicGenerationAdapter } from "@/lib/ai/adapters/anthropic-api"
import { createOpenAIGenerationAdapter } from "@/lib/ai/adapters/openai-api"
import { createOpenRouterGenerationAdapter } from "@/lib/ai/adapters/openrouter-api"
import {
  type ApiGenerationAdapter,
  type ApiModelTuple,
  type ApiProvider,
  type GenerationMessage,
  type GenerationResult,
  type ReasoningEffort,
  type TaskProfile,
  type WorkflowPhase,
} from "@/lib/ai/execution-contract"
import {
  executeGeneration,
  LOCAL_GENERATION_CEILING_MS,
  makeGenerationError,
} from "@/lib/ai/execute-generation"
import {
  assistantModelChoices,
  defaultTupleFor,
  BLOCK_CREATOR_PROFILES,
  TASK_PROFILE_REQUIREMENTS,
  taskProfileTuple,
  validateTupleForProfiles,
} from "@/lib/ai/task-profiles"
import { readLocalApiKeys } from "@/lib/local-api-keys-file"
import type { ModelCatalog } from "@/lib/ai/model-catalog"

export interface EngineImage {
  path: string
  mediaType: string
}

export interface LocalApiRequest {
  provider: ApiProvider
  instructions: string
  prompt: string
  images: readonly EngineImage[]
  profile: TaskProfile
  phase: WorkflowPhase
  model?: string
  effort?: ReasoningEffort
  /** The shared model catalog the tuple is checked against: the Block
   *  creator passes the entries from Convex, the terminal the bundled one. */
  catalog: ModelCatalog
  signal?: AbortSignal
  deadlineMs?: number
}

const LOCAL_API_ENGINE_IDS = {
  openrouter: "openrouter-api",
  anthropic: "anthropic-api",
  openai: "openai-api",
} as const

async function loadImageDataUrl(image: EngineImage): Promise<string> {
  const buffer = await readFile(image.path)
  return `data:${image.mediaType};base64,${buffer.toString("base64")}`
}

/** Nothing chosen: a Block creator step uses the default Settings shows
 *  (`defaultTupleFor` over both Block creator profiles and the same catalog),
 *  so a committed default that is no longer offered is replaced the same way.
 *  Other profiles keep their committed default. */
function noOverrideDefault(
  provider: ApiProvider,
  profile: TaskProfile,
  catalog: ModelCatalog,
  now: number
): { model: string; effort?: ReasoningEffort } | undefined {
  if (!(BLOCK_CREATOR_PROFILES as readonly TaskProfile[]).includes(profile)) return undefined
  const primary = BLOCK_CREATOR_PROFILES[0]
  const fallback = defaultTupleFor(
    provider,
    primary,
    assistantModelChoices(BLOCK_CREATOR_PROFILES, catalog, now)[provider]
  )
  // The committed default is offered: the step keeps its own committed tuple.
  if (!fallback || fallback === taskProfileTuple(provider, primary)) return undefined
  return {
    model: fallback.model,
    ...("reasoning" in fallback && fallback.reasoning
      ? { effort: fallback.reasoning.effort }
      : {}),
  }
}

export function resolveLocalApiTuple(
  provider: ApiProvider,
  profile: TaskProfile,
  overrides: { model?: string; effort?: ReasoningEffort },
  catalog: ModelCatalog,
  now: number = Date.now()
): Readonly<ApiModelTuple> {
  let model = overrides.model?.trim()
  let effort = overrides.effort
  if (!model && !effort) {
    const chosen = noOverrideDefault(provider, profile, catalog, now)
    if (!chosen) return taskProfileTuple(provider, profile)
    model = chosen.model
    effort = chosen.effort
  }
  if (!model) {
    throw new Error("--engine-effort requires --engine-model.")
  }

  const candidate = effort
    ? Object.freeze({
        mode: "catalog" as const,
        provider,
        model,
        reasoning: Object.freeze({ kind: "effort" as const, effort }),
      })
    : Object.freeze({ mode: "catalog" as const, provider, model })

  try {
    return validateTupleForProfiles(candidate, [profile], catalog)
  } catch {
    if (!effort) {
      throw new Error(
        "--engine-model requires --engine-effort unless the selected catalog model has no effort control."
      )
    }
    throw new Error(
      `Unsupported ${provider} model/effort tuple for ${profile}.`
    )
  }
}

// Read at each call: an edited .env.local applies without a restart.
function credentialFor(provider: ApiProvider): string | undefined {
  return readLocalApiKeys()[provider]
}

function adapterFor(
  provider: ApiProvider,
  apiKey: string
): ApiGenerationAdapter {
  if (provider === "openrouter") {
    return createOpenRouterGenerationAdapter({
      apiKey,
      appName: "formulacms-cli",
      appUrl: "https://github.com/formulacms",
    })
  }
  if (provider === "anthropic") {
    return createAnthropicGenerationAdapter({ apiKey })
  }
  return createOpenAIGenerationAdapter({ apiKey })
}

export async function generateWithLocalApi(
  request: LocalApiRequest,
  accounting?: GenerationAccounting
): Promise<GenerationResult<string>> {
  if (!accounting)
    throw new Error(
      "Local BYOK generation requires owner-session accounting; session-less CLI generation is disabled."
    )
  const tuple = resolveLocalApiTuple(
    request.provider,
    request.profile,
    { model: request.model, effort: request.effort },
    request.catalog
  )
  const baseMessages: GenerationMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: request.prompt }],
    },
  ]
  const baseRequest = generationRequest(baseMessages, request, tuple)
  const apiKey = credentialFor(request.provider)
  if (!apiKey) {
    throw makeGenerationError("CONFIG_MISSING", {
      request: baseRequest,
      attempts: 0,
    })
  }

  const imageParts = await Promise.all(
    request.images.map(async (image) => {
      const data = await loadImageDataUrl(image)
      if (data.length > 950_000) {
        throw makeGenerationError("INPUT_TOO_LARGE", {
          request: baseRequest,
          attempts: 0,
        })
      }
      return { type: "file" as const, data, mediaType: image.mediaType }
    })
  )
  const messages: GenerationMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: request.prompt }, ...imageParts],
    },
  ]
  const executionRequest = generationRequest(messages, request, tuple)
  return executeGeneration(
    executionRequest,
    adapterFor(request.provider, apiKey),
    accounting
  )
}

function generationRequest(
  messages: readonly GenerationMessage[],
  request: LocalApiRequest,
  tuple: Readonly<ApiModelTuple>
) {
  return {
    target: {
      lane: "local-build",
      provider: request.provider,
      engine: LOCAL_API_ENGINE_IDS[request.provider],
    },
    tuple,
    profile: request.profile,
    phase: request.phase,
    instructions: request.instructions,
    input: { messages },
    requirements: {
      inputModalities:
        request.images.length > 0
          ? (["text", "image"] as const)
          : (["text"] as const),
      structuredOutput:
        TASK_PROFILE_REQUIREMENTS[request.profile].structuredOutput,
    },
    output: { kind: "text" },
    deadlineMs: request.deadlineMs ?? LOCAL_GENERATION_CEILING_MS,
    signal: request.signal,
    catalogEntry:
      tuple.mode === "catalog"
        ? request.catalog.get(tuple.provider, tuple.model)
        : undefined,
  } as const
}
