"use client"

import { marked } from "marked"
import { generateRichTextDocument } from "@/lib/rich-text/legacy-html"

export type MarkdownImportResult = {
  title: string
  /** PM-JSON serialized as a string (ready to store in Convex). */
  body: string
  /** True if the first H1 was extracted as the page title. */
  titleExtracted: boolean
}

/**
 * Parse a Markdown string into a page title + full-profile PM-JSON body string.
 *
 * The first H1 (`# …`) is extracted as the page title and removed from the
 * body. Everything else becomes a single `rich-text-body` slice value via
 * TipTap's `generateJSON` + the `full` profile extension set — so the output
 * is guaranteed to match the allowlist that `validateDoc` enforces on save.
 */
export function markdownToPmJson(
  markdown: string,
  fallbackTitle = ""
): MarkdownImportResult {
  const trimmed = markdown.trim()

  // Extract first H1 (ATX style: `# Title`) as the page title.
  const h1Re = /^#[ \t]+(.+)$/m
  const h1Match = trimmed.match(h1Re)
  const title = h1Match ? h1Match[1].trim() : fallbackTitle
  const titleExtracted = h1Match !== null

  // Remove the H1 line (and any blank line immediately after it) from the body.
  const bodyMarkdown = h1Match
    ? trimmed.replace(/^#[ \t]+.+\n?/m, "").replace(/^\n/, "").trim()
    : trimmed

  // Markdown → HTML. `marked` is synchronous with `async: false` (the default
  // when using `marked.parse` without await).
  const html = marked.parse(bodyMarkdown) as string

  // HTML → PM-JSON using TipTap's generateJSON with the `full` profile
  // extensions — the same set used by the editor and validateDoc.
  const pmDoc = generateRichTextDocument(html, "full")

  return { title, body: JSON.stringify(pmDoc), titleExtracted }
}

/** Read a File object as text. */
export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}
