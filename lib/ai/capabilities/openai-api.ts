import type {
  ApiModelCapability,
  CapabilitySource,
  ReasoningEffort,
} from "../execution-contract"

export const OPENAI_API_SOURCES = [
  {
    url: "https://developers.openai.com/api/docs/models/gpt-6.1-sol",
    retrievedAt: "2026-11-09",
    claim:
      "GPT-6.1 Sol: canonical API ID, display name, modalities, structured output and model-specific reasoning efforts.",
  },
  {
    url: "https://developers.openai.com/api/docs/models/gpt-6-astra",
    retrievedAt: "2026-11-09",
    claim:
      "GPT-6 Astra: canonical API ID, display name, modalities, structured output and model-specific reasoning efforts.",
  },
  {
    url: "https://developers.openai.com/api/docs/models/gpt-6.1-terra",
    retrievedAt: "2026-11-09",
    claim:
      "GPT-6.1 Terra: canonical API ID, display name, modalities, structured output and model-specific reasoning efforts.",
  },
  {
    url: "https://developers.openai.com/api/docs/models/gpt-6-sol",
    retrievedAt: "2026-11-09",
    claim:
      "GPT-6 Sol: canonical API ID, display name, modalities, structured output and model-specific reasoning efforts.",
  },
  {
    url: "https://developers.openai.com/api/docs/models/gpt-6-luna",
    retrievedAt: "2026-11-09",
    claim:
      "GPT-6 Luna: canonical API ID, display name, modalities, structured output and model-specific reasoning efforts.",
  },
  {
    url: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
    retrievedAt: "2026-11-09",
    claim:
      "GPT-5.6 Sol: canonical API ID, display name, modalities, structured output and model-specific reasoning efforts.",
  },
  {
    url: "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
    retrievedAt: "2026-11-09",
    claim:
      "GPT-5.6 Terra: canonical API ID, display name, modalities, structured output and model-specific reasoning efforts.",
  },
  {
    url: "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
    retrievedAt: "2026-11-09",
    claim:
      "GPT-5.6 Luna: canonical API ID, display name, modalities, structured output and model-specific reasoning efforts.",
  },
  {
    url: "https://developers.openai.com/api/docs/guides/reasoning",
    retrievedAt: "2026-11-09",
    claim:
      "Reasoning efforts are model-specific; GPT-6.1 Sol and Astra exclude none. GPT-5.6 and Sol/Luna default to medium.",
  },
  {
    url: "https://community.openai.com/t/what-is-the-default-level-of-reasoning-for-gpt-6-astra/1408343/7",
    retrievedAt: "2026-11-09",
    claim:
      "OpenAI Support confirms GPT-6 Astra defaults to medium when reasoning effort is omitted.",
  },
  {
    url: "https://developers.openai.com/api/docs/deprecations",
    retrievedAt: "2026-11-09",
    claim:
      "No shutdown is announced for these eight catalog model IDs.",
  },
] as const satisfies readonly CapabilitySource[]

export const OPENAI_API_CATALOG = {
  "gpt-6.1-sol": {
    name: "GPT-6.1 Sol",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    structuredOutput: true,
    reasoning: {
      kind: "effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      providerDefault: "medium",
    },
  },
  "gpt-6-astra": {
    name: "GPT-6 Astra",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    structuredOutput: true,
    reasoning: {
      kind: "effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      providerDefault: "medium",
    },
  },
  "gpt-6.1-terra": {
    name: "GPT-6.1 Terra",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    structuredOutput: true,
    reasoning: {
      kind: "effort",
      supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      providerDefault: "medium",
    },
  },
  "gpt-6-sol": {
    name: "GPT-6 Sol",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    structuredOutput: true,
    reasoning: {
      kind: "effort",
      supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      providerDefault: "medium",
    },
  },
  "gpt-6-luna": {
    name: "GPT-6 Luna",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    structuredOutput: true,
    reasoning: {
      kind: "effort",
      supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      providerDefault: "medium",
    },
  },
  "gpt-5.6-sol": {
    name: "GPT-5.6 Sol",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    structuredOutput: true,
    reasoning: {
      kind: "effort",
      supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      providerDefault: "medium",
    },
  },
  "gpt-5.6-terra": {
    name: "GPT-5.6 Terra",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    structuredOutput: true,
    reasoning: {
      kind: "effort",
      supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      providerDefault: "medium",
    },
  },
  "gpt-5.6-luna": {
    name: "GPT-5.6 Luna",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    structuredOutput: true,
    reasoning: {
      kind: "effort",
      supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      providerDefault: "medium",
    },
  },
} as const satisfies Record<string, ApiModelCapability>

export type OpenAIApiModel = keyof typeof OPENAI_API_CATALOG
type EffortFor<M extends OpenAIApiModel> =
  (typeof OPENAI_API_CATALOG)[M]["reasoning"]["supportedEfforts"][number]

export type OpenAIApiTuple = {
  [M in OpenAIApiModel]: {
    readonly mode: "catalog"
    readonly provider: "openai"
    readonly model: M
    readonly reasoning: {
      readonly kind: "effort"
      readonly effort: EffortFor<M>
    }
  }
}[OpenAIApiModel]

export function isOpenAIApiModel(value: string): value is OpenAIApiModel {
  return Object.prototype.hasOwnProperty.call(OPENAI_API_CATALOG, value)
}

export function isOpenAIEffort<M extends OpenAIApiModel>(
  model: M,
  effort: ReasoningEffort
): effort is EffortFor<M> {
  return (
    OPENAI_API_CATALOG[model].reasoning
      .supportedEfforts as readonly ReasoningEffort[]
  ).includes(effort)
}
