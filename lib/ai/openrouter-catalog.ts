import type {
  ApiModelCapability,
  InputModality,
  ReasoningEffort,
} from "./execution-contract"

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
export const OPENROUTER_CATALOG_MAX_MODELS = 1_000
export const OPENROUTER_PORTABLE_EFFORTS = [
  "high",
  "medium",
  "low",
] as const satisfies readonly ReasoningEffort[]

const INPUT_MODALITIES = new Set<InputModality>([
  "text",
  "image",
  "file",
  "audio",
  "video",
])

export interface OpenRouterCatalogModel {
  readonly modelId: string
  readonly name: string
  readonly inputModalities: InputModality[]
  readonly structuredOutput: boolean
  readonly reasoningEfforts: ReasoningEffort[]
  readonly inputPerM?: number
  readonly outputPerM?: number
  readonly ceilingInputPerM?: number
  readonly ceilingOutputPerM?: number
}

type OpenRouterModelResponse = {
  id?: unknown
  name?: unknown
  pricing?: {
    prompt?: unknown
    completion?: unknown
  }
  supported_parameters?: unknown
  architecture?: {
    input_modalities?: unknown
    output_modalities?: unknown
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function pricePerMillion(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined
  const perToken = Number(value)
  if (!Number.isFinite(perToken) || perToken < 0) return undefined
  return Number((perToken * 1_000_000).toFixed(6))
}

const INPUT_PRICE_KEYS = new Set([
  "prompt",
  "input_cache_read",
  "input_cache_write",
  "input_cache_write_1h",
  "image",
  "audio",
  "input_audio_cache",
])
const OUTPUT_PRICE_KEYS = new Set(["completion", "internal_reasoning"])
const UNUSED_PRICE_KEYS = new Set([
  "web_search",
  "image_output",
  "audio_output",
])
const CONDITION_KEYS = new Set([
  "min_prompt_tokens",
  "utc_start",
  "utc_end",
  "utc_days",
])

/** Ceiling across every conditional rate, not only the window active at sync.
 * Unknown dimensions are incomplete rather than silently ignored. */
function priceCeilings(
  pricing: unknown
): { ceilingInputPerM: number; ceilingOutputPerM: number } | undefined {
  if (
    !isRecord(pricing) ||
    pricing.prompt === undefined ||
    pricing.completion === undefined
  )
    return undefined
  const overrides = pricing.overrides ?? []
  if (!Array.isArray(overrides)) return undefined
  let input = 0,
    output = 0
  for (const [index, entry] of [pricing, ...overrides].entries()) {
    if (!isRecord(entry)) return undefined
    for (const [key, value] of Object.entries(entry)) {
      if (index === 0 && key === "overrides") continue
      if (index > 0 && CONDITION_KEYS.has(key)) {
        if (key === "utc_days") {
          if (
            !Array.isArray(value) ||
            value.some(
              (day) =>
                typeof day !== "string" ||
                ![
                  "monday",
                  "tuesday",
                  "wednesday",
                  "thursday",
                  "friday",
                  "saturday",
                  "sunday",
                ].includes(day)
            )
          )
            return undefined
        } else {
          const parsed =
            typeof value === "number"
              ? value
              : typeof value === "string" && value.trim()
                ? Number(value)
                : NaN
          if (
            !Number.isSafeInteger(parsed) ||
            parsed < 0 ||
            (key !== "min_prompt_tokens" &&
              (parsed > 2359 || parsed % 100 > 59))
          )
            return undefined
        }
        continue
      }
      if (
        !INPUT_PRICE_KEYS.has(key) &&
        !OUTPUT_PRICE_KEYS.has(key) &&
        !UNUSED_PRICE_KEYS.has(key) &&
        key !== "request"
      )
        return undefined
      if (
        (typeof value !== "string" && typeof value !== "number") ||
        (typeof value === "string" && !value.trim())
      )
        return undefined
      const parsed = Number(value)
      if (
        !Number.isFinite(parsed) ||
        parsed < 0 ||
        (key === "request" && parsed !== 0)
      )
        return undefined
      if (INPUT_PRICE_KEYS.has(key)) input = Math.max(input, parsed)
      if (OUTPUT_PRICE_KEYS.has(key)) output = Math.max(output, parsed)
    }
  }
  // Round upward to one micro-USD per million; display conversion stays intact.
  const ceilingInputPerM = Math.ceil(input * 1e12) / 1e6
  const ceilingOutputPerM = Math.ceil(output * 1e12) / 1e6
  if (
    ![ceilingInputPerM, ceilingOutputPerM].every(
      (rate) =>
        Number.isFinite(rate) && Number.isSafeInteger(Math.round(rate * 1e6))
    )
  )
    return undefined
  return { ceilingInputPerM, ceilingOutputPerM }
}

/** Normalize and bound the public OpenRouter model response before storage. */
export function parseOpenRouterCatalog(
  value: unknown
): OpenRouterCatalogModel[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error("OpenRouter returned an invalid model catalog.")
  }
  if (
    value.data.length === 0 ||
    value.data.length > OPENROUTER_CATALOG_MAX_MODELS
  ) {
    throw new Error(
      `OpenRouter returned ${value.data.length} models; expected 1-${OPENROUTER_CATALOG_MAX_MODELS}.`
    )
  }

  const seen = new Set<string>()
  const models: OpenRouterCatalogModel[] = []
  for (const raw of value.data) {
    if (!isRecord(raw)) {
      throw new Error("OpenRouter returned a malformed model entry.")
    }
    const model = raw as OpenRouterModelResponse
    if (typeof model.id !== "string" || !model.id.trim()) {
      throw new Error("OpenRouter returned a model without an id.")
    }
    const modelId = model.id.trim()
    if (seen.has(modelId)) {
      throw new Error(`OpenRouter returned duplicate model id ${modelId}.`)
    }
    seen.add(modelId)

    const outputs = stringArray(model.architecture?.output_modalities)
    if (outputs.length > 0 && !outputs.includes("text")) continue

    const inputs = stringArray(model.architecture?.input_modalities).filter(
      (input): input is InputModality =>
        INPUT_MODALITIES.has(input as InputModality)
    )
    const parameters = new Set(stringArray(model.supported_parameters))
    const supportsReasoning =
      parameters.has("reasoning") || parameters.has("reasoning_effort")
    const inputPerM = pricePerMillion(model.pricing?.prompt)
    const outputPerM = pricePerMillion(model.pricing?.completion)

    models.push({
      modelId,
      name:
        typeof model.name === "string" && model.name.trim()
          ? model.name.trim()
          : modelId,
      inputModalities: inputs.length > 0 ? inputs : ["text"],
      structuredOutput:
        parameters.has("structured_outputs") ||
        parameters.has("response_format"),
      reasoningEfforts: supportsReasoning
        ? [...OPENROUTER_PORTABLE_EFFORTS]
        : [],
      ...priceCeilings(model.pricing),
      ...(inputPerM === undefined ? {} : { inputPerM }),
      ...(outputPerM === undefined ? {} : { outputPerM }),
    })
  }

  if (models.length === 0) {
    throw new Error("OpenRouter returned no text-output models.")
  }
  return models.sort((a, b) => a.modelId.localeCompare(b.modelId))
}

export function openRouterCatalogCapability(
  model: OpenRouterCatalogModel
): ApiModelCapability {
  return {
    inputModalities: model.inputModalities,
    outputModalities: ["text"],
    structuredOutput: model.structuredOutput,
    reasoning:
      model.reasoningEfforts.length > 0
        ? {
            kind: "effort",
            supportedEfforts: model.reasoningEfforts,
            providerDefault: "medium",
          }
        : { kind: "unsupported" },
    ...(model.inputPerM === undefined || model.outputPerM === undefined
      ? {}
      : {
          pricing: {
            inputPerM: model.inputPerM,
            outputPerM: model.outputPerM,
          },
        }),
  }
}
