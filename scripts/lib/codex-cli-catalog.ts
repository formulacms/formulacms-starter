import type {
  InputModality,
  ReasoningEffort,
} from "../../lib/ai/execution-contract"
import {
  isSelectableSubscriptionCliEffort,
  type ObservedCodexCatalog,
  type ObservedCodexModelCapability,
} from "./subscription-cli-capabilities"

export class CodexCliCatalogError extends Error {
  readonly category: "INVALID_OUTPUT" | "LOCAL_PROCESS_FAILED"

  constructor(category: "INVALID_OUTPUT" | "LOCAL_PROCESS_FAILED") {
    super(
      category === "INVALID_OUTPUT"
        ? "The Codex model catalog returned incomplete or invalid output."
        : "The Codex model catalog request failed."
    )
    this.name = "CodexCliCatalogError"
    this.category = category
  }
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidOutput(): never {
  throw new CodexCliCatalogError("INVALID_OUTPUT")
}

const INPUT_MODALITIES = Object.freeze([
  "text",
  "image",
  "file",
  "audio",
  "video",
] as const satisfies readonly InputModality[])

// The installed catalog legitimately advertises capability values formulacms does
// not model or deliberately refuses to select — `ultra` is outside the shared
// ReasoningEffort union, and `max`/`ultra` sit above the owner's xhigh ceiling.
// Such a value must never be fatal: rejecting the page would make the whole
// catalog unreadable because one entry knows more than we do. Malformed SHAPES
// (wrong types) stay fatal; unrecognized VALUES are dropped, which can only
// narrow what is selectable and therefore always fails closed.
function parseCapability(value: unknown): ObservedCodexModelCapability {
  if (!isObject(value) || typeof value.model !== "string" || value.model === "") {
    invalidOutput()
  }
  if (
    !Array.isArray(value.supportedReasoningEfforts) ||
    value.supportedReasoningEfforts.length === 0
  ) {
    invalidOutput()
  }
  // Optional in the installed app-server schema; absence means the model
  // declares no modality here, so the image gate fails closed for it.
  if (value.inputModalities !== undefined && !Array.isArray(value.inputModalities)) {
    invalidOutput()
  }

  const supportedReasoningEfforts = value.supportedReasoningEfforts
    .map((item): string => {
      if (!isObject(item) || typeof item.reasoningEffort !== "string") {
        invalidOutput()
      }
      return item.reasoningEffort
    })
    .filter(isSelectableSubscriptionCliEffort)
    .map((effort): { readonly reasoningEffort: ReasoningEffort } =>
      Object.freeze({ reasoningEffort: effort })
    )

  const inputModalities = (value.inputModalities ?? [])
    .map((item): string => {
      if (typeof item !== "string") invalidOutput()
      return item
    })
    .filter((item): item is InputModality =>
      (INPUT_MODALITIES as readonly string[]).includes(item)
    )

  // Menu fields: kept only when well formed, never fatal (they can only add
  // a name, a default effort or a suggestion; `hidden` absent means visible).
  const text = (field: unknown) =>
    typeof field === "string" && field !== "" ? field : undefined
  const displayName = text(value.displayName)
  const upgrade = text(value.upgrade)
  const defaultEffort = text(value.defaultReasoningEffort)
  const defaultReasoningEffort =
    defaultEffort !== undefined && isSelectableSubscriptionCliEffort(defaultEffort)
      ? defaultEffort
      : undefined

  return Object.freeze({
    model: value.model,
    supportedReasoningEfforts: Object.freeze(supportedReasoningEfforts),
    inputModalities: Object.freeze(inputModalities),
    ...(typeof value.hidden === "boolean" ? { hidden: value.hidden } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(defaultReasoningEffort !== undefined ? { defaultReasoningEffort } : {}),
    ...(upgrade !== undefined ? { upgrade } : {}),
  })
}

export type RequestCodexModelListPage = (request: {
  readonly cursor: string | undefined
  readonly limit: number
}) => Promise<unknown>

export async function readCodexCliCatalog(options: {
  readonly requestPage: RequestCodexModelListPage
  readonly pageSize?: number
}): Promise<Readonly<ObservedCodexCatalog>> {
  const pageSize = options.pageSize ?? 100
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    invalidOutput()
  }

  const data: ObservedCodexModelCapability[] = []
  const seenModels = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  for (let page = 0; page < 100; page += 1) {
    let value: unknown
    try {
      value = await options.requestPage({ cursor, limit: pageSize })
    } catch {
      throw new CodexCliCatalogError("LOCAL_PROCESS_FAILED")
    }
    if (!isObject(value) || !Array.isArray(value.data)) invalidOutput()

    for (const rawCapability of value.data) {
      const capability = parseCapability(rawCapability)
      if (seenModels.has(capability.model)) invalidOutput()
      seenModels.add(capability.model)
      data.push(capability)
    }

    if (value.nextCursor === null || value.nextCursor === undefined) {
      return Object.freeze({ data: Object.freeze(data) })
    }
    if (typeof value.nextCursor !== "string" || value.nextCursor === "") {
      invalidOutput()
    }
    if (seenCursors.has(value.nextCursor)) invalidOutput()
    seenCursors.add(value.nextCursor)
    cursor = value.nextCursor
  }

  return invalidOutput()
}
