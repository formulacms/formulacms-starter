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
  TASK_PROFILE_REQUIREMENTS,
  taskProfileTuple,
  validateTupleForProfiles,
} from "@/lib/ai/task-profiles"
import { LOCAL_API_KEY_NAMES } from "@/lib/local-api-keys"

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

export function resolveLocalApiTuple(
  provider: ApiProvider,
  profile: TaskProfile,
  overrides: { model?: string; effort?: ReasoningEffort } = {}
): Readonly<ApiModelTuple> {
  const model = overrides.model?.trim()
  const effort = overrides.effort
  if (!model && !effort) return taskProfileTuple(provider, profile)
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
    return validateTupleForProfiles(candidate, [profile])
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

function credentialFor(provider: ApiProvider): string | undefined {
  const [currentName, legacyName] = LOCAL_API_KEY_NAMES[provider]
  return (
    process.env[currentName]?.trim() ||
    process.env[legacyName]?.trim() ||
    undefined
  )
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
  const tuple = resolveLocalApiTuple(request.provider, request.profile, {
    model: request.model,
    effort: request.effort,
  })
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
  } as const
}
