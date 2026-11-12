import type { ApiModelCapability, ReasoningEffort } from "../execution-contract"
import {
  OPENROUTER_GENERATED_CATALOG,
  type GeneratedCatalogEntry,
} from "./openrouter-catalog.generated"

export const OPENROUTER_API_SOURCES = [
  {
    url: "https://openrouter.ai/api/v1/models",
    retrievedAt: "2026-07-12",
    claim:
      "Live model list: model IDs, per-token prompt/completion pricing, input modalities, and supported_parameters (reasoning / reasoning_effort marks effort support).",
  },
  {
    url: "https://openrouter.ai/docs/guides/best-practices/reasoning-tokens",
    retrievedAt: "2026-07-12",
    claim:
      "Reasoning-capable models accept a universal reasoning.effort of low, medium, or high; the catalog also exposes supported_efforts and default_effort.",
  },
] as const

/**
 * The full OpenRouter catalog the operator picks from freely (admin agency).
 * Generated from the live model list by `scripts/sync-openrouter-catalog.ts` —
 * one entry per text-output model, with per-million pricing and reasoning-effort
 * support. Because the operator may choose ANY of these, the model id type is a
 * plain string (not a literal union) and the storage validator is permissive;
 * OpenRouter validates the exact model+effort at call time (fail-loud).
 */
export const OPENROUTER_API_CATALOG: Record<string, GeneratedCatalogEntry> =
  OPENROUTER_GENERATED_CATALOG

/** A free-form model id, since the admin may pick any catalog model. */
export type OpenRouterApiModel = string

export interface OpenRouterApiTuple {
  readonly mode: "catalog"
  readonly provider: "openrouter"
  readonly model: string
  /** Absent for the catalog's ~140 no-reasoning models; the request then omits
   *  effort and the model runs at its provider default. */
  readonly reasoning?: {
    readonly kind: "effort"
    readonly effort: ReasoningEffort
  }
}

/** D1-only compatibility shape for existing free-form OpenRouter settings.
 * It deliberately has no effort field and cannot be produced by task profiles. */
export interface LegacyOpenRouterApiTuple {
  readonly mode: "legacy"
  readonly provider: "openrouter"
  readonly model: string
}

export function isOpenRouterApiModel(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(OPENROUTER_API_CATALOG, value)
}

export function openRouterCapability(
  model: string
): ApiModelCapability | undefined {
  return isOpenRouterApiModel(model)
    ? OPENROUTER_API_CATALOG[model]
    : undefined
}

export function isOpenRouterEffort(
  model: string,
  effort: ReasoningEffort
): boolean {
  const capability = OPENROUTER_API_CATALOG[model]
  if (!capability || capability.reasoning.kind !== "effort") return false
  return (capability.reasoning.supportedEfforts as readonly ReasoningEffort[]).includes(
    effort
  )
}
