import type {
  ApiModelCapability,
  CapabilitySource,
  ReasoningEffort,
} from "../execution-contract"

export const ANTHROPIC_API_SOURCES = [
  {
    url: "https://platform.claude.com/docs/en/models/overview",
    retrievedAt: "2026-11-09",
    claim:
      "Canonical Claude API model IDs, display names, text/image input and text output.",
  },
  {
    url: "https://platform.claude.com/docs/en/build-with-claude/effort",
    retrievedAt: "2026-11-09",
    claim:
      "Per-model effort levels and defaults: Opus 5.5 and Haiku 5.5 default to medium; Sonnet 5.5, Fable 5.1, Sonnet 5 and Opus 4.8 default to high. Haiku 4.5 has no effort control.",
  },
  {
    url: "https://platform.claude.com/docs/en/build-with-claude/structured-outputs",
    retrievedAt: "2026-11-09",
    claim:
      "Structured outputs are available on every Claude model; capability does not imply the product requests a native format.",
  },
  {
    url: "https://platform.claude.com/docs/en/about-claude/model-deprecations",
    retrievedAt: "2026-11-09",
    claim:
      "All seven catalog IDs remain active; retained legacy models have no announced shutdown.",
  },
] as const satisfies readonly CapabilitySource[]

export const ANTHROPIC_API_CATALOG = {
  "claude-sonnet-5-5": {
    name: "Claude Sonnet 5.5",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    structuredOutput: true,
    reasoning: {
      kind: "effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      providerDefault: "high",
    },
  },
  "claude-opus-5-5": {
    name: "Claude Opus 5.5",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    structuredOutput: true,
    reasoning: {
      kind: "effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      providerDefault: "medium",
    },
  },
  "claude-haiku-5-5": {
    name: "Claude Haiku 5.5",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    structuredOutput: true,
    reasoning: {
      kind: "effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      providerDefault: "medium",
    },
  },
  "claude-fable-5-1": {
    name: "Claude Fable 5.1",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    structuredOutput: true,
    reasoning: {
      kind: "effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      providerDefault: "high",
    },
  },
  "claude-sonnet-5": {
    name: "Claude Sonnet 5",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    structuredOutput: true,
    reasoning: {
      kind: "effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      providerDefault: "high",
    },
  },
  "claude-opus-4-8": {
    name: "Claude Opus 4.8",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    structuredOutput: true,
    reasoning: {
      kind: "effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      providerDefault: "high",
    },
  },
  "claude-haiku-4-5-20251001": {
    name: "Claude Haiku 4.5",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    structuredOutput: true,
    reasoning: { kind: "unsupported" },
  },
} as const satisfies Record<string, ApiModelCapability>

export type AnthropicApiModel = keyof typeof ANTHROPIC_API_CATALOG
export type AnthropicEffortModel = {
  [M in AnthropicApiModel]: (typeof ANTHROPIC_API_CATALOG)[M]["reasoning"]["kind"] extends "effort" ? M : never
}[AnthropicApiModel]
type EffortFor<M extends AnthropicEffortModel> =
  (typeof ANTHROPIC_API_CATALOG)[M]["reasoning"]["supportedEfforts"][number]

export type AnthropicApiTuple =
  | {
      [M in AnthropicEffortModel]: {
        readonly mode: "catalog"
        readonly provider: "anthropic"
        readonly model: M
        readonly reasoning: {
          readonly kind: "effort"
          readonly effort: EffortFor<M>
        }
      }
    }[AnthropicEffortModel]
  | {
      readonly mode: "catalog"
      readonly provider: "anthropic"
      readonly model: "claude-haiku-4-5-20251001"
      readonly reasoning?: never
    }

export function isAnthropicApiModel(value: string): value is AnthropicApiModel {
  return Object.prototype.hasOwnProperty.call(ANTHROPIC_API_CATALOG, value)
}

export function isAnthropicEffort<M extends AnthropicEffortModel>(
  model: M,
  effort: ReasoningEffort
): effort is EffortFor<M> {
  return (
    ANTHROPIC_API_CATALOG[model].reasoning
      .supportedEfforts as readonly ReasoningEffort[]
  ).includes(effort)
}
