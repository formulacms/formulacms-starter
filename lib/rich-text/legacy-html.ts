import { generateHTML, generateJSON } from "@tiptap/html"
import { Mark, type JSONContent } from "@tiptap/core"

import {
  sanitizeLegacyHtml,
  type RichTextProfile,
} from "@/convex/lib/richtext/profiles"
import { extensionsForProfile } from "./extensions"
import { validateStrict } from "@/convex/lib/richtext/strict"

/** Keep the one server-DOM-backed TipTap import isolated to the legacy boundary. */
export function sanitizeAndRenderLegacyHtml(
  html: string,
  profile: RichTextProfile
): string {
  const sanitized = sanitizeLegacyHtml(html, profile)
  return profile === "inline" ? flattenInlineHtml(sanitized) : sanitized
}

export function generateRichTextHtml(
  document: JSONContent,
  profile: RichTextProfile
): string {
  const html = generateHTML(document, extensionsForProfile(profile))
  return profile === "inline" ? flattenInlineHtml(html) : html
}

export function generateRichTextDocument(
  html: string,
  profile: RichTextProfile,
  preserveTitleLinks = false
): JSONContent {
  const extensions = extensionsForProfile(profile).map((extension) =>
    preserveTitleLinks && extension instanceof Mark && extension.name === "link"
      ? extension.extend({
          // The upstream rule accepts a[href] only. Retain CMS-only addresses
          // for authored body links and the title adoption report.
          parseHTML() {
            return [
              ...(this.parent?.() ?? []),
              { tag: "a[data-page-id]:not([href])" },
            ]
          },
        })
      : extension
  )
  return generateJSON(html, extensions)
}

/** Parent-only adoption for authored rich text. Canonical PM stays byte exact;
 * malformed/structured JSON is left for the strict writer to refuse. Plain
 * legacy strings are literal text (including Markdown-looking strings).
 */
export function prepareLegacyRichText(
  value: string,
  profile: RichTextProfile
): string {
  if (validateStrict(profile, value).ok) return value
  let legacy = value
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== "string") {
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.keys(parsed).length !== 2 ||
        !("type" in parsed) ||
        parsed.type !== "doc" ||
        !("content" in parsed) ||
        !Array.isArray(parsed.content) ||
        parsed.content.length !== 0
      )
        return value
      legacy = ""
    } else legacy = parsed
  } catch {
    if (/^[{\[]/.test(value.trim())) return value
  }
  const document = /<\/?[a-z][^>]*>/i.test(legacy)
    ? generateRichTextDocument(
        sanitizeLegacyHtml(legacy, profile),
        profile,
        true
      )
    : {
        type: "doc",
        content: [
          {
            type: "paragraph",
            ...(legacy
              ? {
                  content: legacy
                    .split("\n")
                    .flatMap((line, index) => [
                      ...(index ? [{ type: "hardBreak" }] : []),
                      ...(line ? [{ type: "text", text: line }] : []),
                    ]),
                }
              : {}),
          },
        ],
      }
  const candidate = JSON.stringify(document)
  const checked = validateStrict(profile, candidate)
  if (!checked.ok)
    throw new Error(`RICH_TEXT_CONVERSION_FAILED: ${checked.error}`)
  return candidate
}

/**
 * The inline profile allows paragraph nodes as PM structure, but its host can
 * be a span. Flatten only complete top-level paragraphs to keep HTML valid and
 * hydration stable, preserving the previous inline HTML path byte for byte.
 */
function flattenInlineHtml(html: string): string {
  const trimmed = html.trim()
  if (!trimmed.includes("<p")) return html

  const paragraphs = Array.from(
    trimmed.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi),
    (match) => match[1] ?? ""
  )
  const covered = trimmed.replace(/<p(?:\s[^>]*)?>[\s\S]*?<\/p>/gi, "").trim()

  return paragraphs.length > 0 && covered === ""
    ? paragraphs.join("<br><br>")
    : html
}
