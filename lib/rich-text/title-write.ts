import { sanitizeLegacyHtml } from "@/convex/lib/richtext/profiles"
import { generateRichTextDocument } from "./legacy-html"
import {
  resolveFieldContract,
  type ResolvedFieldContract,
} from "@/convex/lib/richtext/contracts"
import { toFieldShape } from "@/convex/lib/richtext/shape"
import { validateStrict } from "@/convex/lib/richtext/strict"

/** Throws on conversion errors. Never use the display reader's empty fallback. */
export function parseLegacyTitle(value: string) {
  let html = value
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed === "string") html = parsed
  } catch {
    /* Raw HTML. */
  }
  const document = generateRichTextDocument(
    sanitizeLegacyHtml(html, "inline"),
    "inline",
    true
  )
  // Keep links until the descriptor-bound conversion, so its report retains addresses.
  const parsed = JSON.stringify(document)
  const canonical = toFieldShape(resolveFieldContract("title"), parsed)
  const result = validateStrict("title", canonical.value)
  if (!result.ok) throw new Error(`TITLE_CONVERSION_FAILED: ${result.error}`)
  return canonical
}

type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === "object" && !Array.isArray(value)

/**
 * A title is one line (ADR-0055 amendment, owner 2026-11-04): every line break
 * becomes one space, whitespace around it collapses and both ends are
 * trimmed, through the shared `toFieldShape`. Pure and used by every title
 * writer. A value that is not a title document, or is already one clean line,
 * comes back unchanged byte for byte.
 */
export function canonicalTitleLine(
  value: string,
  contract: ResolvedFieldContract = resolveFieldContract("title")
): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return value
  }
  if (!isRecord(parsed) || parsed.type !== "doc") return value
  if (!Array.isArray(parsed.content) || !parsed.content.length) return value
  return toFieldShape(contract, value).value
}
