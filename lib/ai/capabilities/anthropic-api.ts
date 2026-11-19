import type {
  ApiModelCapability,
  CapabilitySource,
  DirectApiTuple,
} from "../execution-contract"

export const ANTHROPIC_API_SOURCES = [
  {
    url: "https://platform.claude.com/docs/en/models/overview",
    retrievedAt: "2026-11-15",
    claim:
      "Canonical Claude API model IDs, display names, text/image input and text output.",
  },
  {
    url: "https://platform.claude.com/docs/en/build-with-claude/effort",
    retrievedAt: "2026-11-15",
    claim:
      "Per-model effort levels and defaults: Opus 5.5 and Haiku 5.5 default to medium; Sonnet 5.5, Fable 5.2, Fable 5.1, Sonnet 5 and Opus 4.8 default to high. Haiku 4.5 has no effort control.",
  },
  {
    url: "https://platform.claude.com/docs/en/build-with-claude/structured-outputs",
    retrievedAt: "2026-11-15",
    claim:
      "Structured outputs are available on every Claude model; capability does not imply the product requests a native format.",
  },
  {
    url: "https://platform.claude.com/docs/en/about-claude/model-deprecations",
    retrievedAt: "2026-11-15",
    claim:
      "All eight catalog IDs remain active; retained legacy models have no announced shutdown.",
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
  "claude-fable-5-2": {
    name: "Claude Fable 5.2",
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    structuredOutput: true,
    reasoning: {
      kind: "effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      providerDefault: "high",
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

export type AnthropicApiTuple = DirectApiTuple<"anthropic">

/** The committed capability for one Anthropic model id, if listed. */
export function anthropicCapability(model: string): ApiModelCapability | undefined {
  const catalog: Readonly<Record<string, ApiModelCapability>> = ANTHROPIC_API_CATALOG
  return Object.prototype.hasOwnProperty.call(catalog, model) ? catalog[model] : undefined
}
