import { normalizeFieldPath, type FieldAddress } from "./contracts"
import { resolveFieldContract } from "./contracts"
import { toFieldShape, type FieldShapeResult } from "./shape"
import { validateLegacy } from "./strict"

export interface FieldTransition {
  sliceType: string
  fieldPath: string
  from: "text"
  to: "title"
}

export const FIELD_TRANSITIONS: readonly FieldTransition[] = [
  {
    sliceType: "faq-simple",
    fieldPath: "items.question",
    from: "text",
    to: "title",
  },
]

export type TransitionRead =
  { kind: "plain"; value: string } | { kind: "title"; value: string }

export function transitionForField(
  address: FieldAddress | undefined
): FieldTransition | undefined {
  if (!address) return undefined
  const path = normalizeFieldPath(address.fieldPath)
  return FIELD_TRANSITIONS.find(
    (entry) => entry.sliceType === address.sliceType && entry.fieldPath === path
  )
}

export function readTransitionField(
  address: FieldAddress | undefined,
  value: string
): TransitionRead {
  const transition = transitionForField(address)
  if (!transition || typeof value !== "string")
    return { kind: "plain", value: String(value) }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return { kind: "plain", value }
  }
  if (!isRecord(parsed) || parsed.type !== "doc")
    return { kind: "plain", value }
  if (
    Array.isArray(parsed.content) &&
    parsed.content.some((node) => isRecord(node) && node.type === "heading") &&
    !(
      parsed.content.length === 1 &&
      isRecord(parsed.content[0]) &&
      parsed.content[0].type === "heading"
    )
  ) {
    return { kind: "plain", value }
  }
  const contract = resolveFieldContract({
    contract: "title",
    heading: { role: "itemTitle" },
  })
  const shaped = toFieldShape(contract, value)
  if (!validateLegacy(contract, shaped.value).ok) {
    return { kind: "plain", value }
  }
  return { kind: "title", value: shaped.value }
}

export function readFieldText(
  address: FieldAddress | undefined,
  value: string
): string {
  const result = readTransitionField(address, value)
  return result.kind === "title"
    ? titlePlainProjection(result.value)
    : result.value
}

/** The registered FAQ transition owns the ambiguity between legacy text and
 * title JSON. Plain questions stay literal (including HTML/JSON-looking text
 * and newlines); recognized documents retain their link diagnostics.
 */
export function convertTransitionTitle(
  address: FieldAddress | undefined,
  value: string
): FieldShapeResult | undefined {
  if (!transitionForField(address)) return undefined
  const contract = resolveFieldContract({
    contract: "title",
    heading: { role: "itemTitle" },
  })
  if (readTransitionField(address, value).kind === "title")
    return toFieldShape(contract, value)
  // A title is one line: toFieldShape turns each newline into one space.
  const content = value ? [{ type: "text", text: value }] : []
  return toFieldShape(
    contract,
    JSON.stringify({ type: "doc", content: [{ type: "paragraph", content }] })
  )
}

function titlePlainProjection(value: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return value
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.content)) return value
  const blocks = parsed.content.map((block) => {
    if (!isRecord(block)) return ""
    return inlinePlainText(block.content)
  })
  return blocks.join("\n\n")
}

function inlinePlainText(value: unknown): string {
  if (!Array.isArray(value)) return ""
  return value
    .map((node) => {
      if (!isRecord(node)) return ""
      if (node.type === "text")
        return typeof node.text === "string" ? node.text : ""
      if (node.type === "hardBreak") return "\n"
      return inlinePlainText(node.content)
    })
    .join("")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
