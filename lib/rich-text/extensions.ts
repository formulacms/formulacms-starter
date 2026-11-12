import Document from "@tiptap/extension-document"
import Paragraph from "@tiptap/extension-paragraph"
import Text from "@tiptap/extension-text"
import HardBreak from "@tiptap/extension-hard-break"
import Heading from "@tiptap/extension-heading"
import { BulletList, OrderedList, ListItem } from "@tiptap/extension-list"
import Blockquote from "@tiptap/extension-blockquote"
import CodeBlock from "@tiptap/extension-code-block"
import HorizontalRule from "@tiptap/extension-horizontal-rule"
import Image from "@tiptap/extension-image"
import { Table } from "@tiptap/extension-table"
import { TableRow } from "@tiptap/extension-table-row"
import { TableHeader } from "@tiptap/extension-table-header"
import { TableCell } from "@tiptap/extension-table-cell"
import Bold from "@tiptap/extension-bold"
import Italic from "@tiptap/extension-italic"
import Strike from "@tiptap/extension-strike"
import Underline from "@tiptap/extension-underline"
import Highlight from "@tiptap/extension-highlight"
import Subscript from "@tiptap/extension-subscript"
import Superscript from "@tiptap/extension-superscript"
import Code from "@tiptap/extension-code"
import Link from "@tiptap/extension-link"
import type { Extensions } from "@tiptap/core"
import {
  PROFILE_SPECS,
  type RichTextProfile,
} from "@/convex/lib/richtext/profiles"
import {
  contractSpec,
  type FieldContract,
} from "@/convex/lib/richtext/contracts"

/**
 * Extended Link mark carrying CMS-specific attrs in PM-JSON state:
 *  - `pageId` survives slug renames; the render pre-processor (`render.ts`)
 *    resolves it to the page's current localized href before `generateHTML`.
 *  - `noFollow`/`sponsored`/`ugc` are composed into `rel` by the same
 *    pre-processor — they never render as bare HTML attributes here.
 * Empty `HTMLAttributes` neutralizes the upstream default
 * `rel="noopener noreferrer nofollow"` so the pre-processor owns rel.
 */
const ConfiguredLink = Link.extend({
  addAttributes() {
    const parent = this.parent?.() ?? {}
    return {
      ...parent,
      pageId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-page-id"),
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.pageId ? { "data-page-id": String(attrs.pageId) } : {},
      },
      noFollow: {
        default: null,
        parseHTML: (el: HTMLElement) =>
          (el.getAttribute("rel") || "").split(/\s+/).includes("nofollow") ||
          null,
        renderHTML: () => ({}),
      },
      sponsored: {
        default: null,
        parseHTML: (el: HTMLElement) =>
          (el.getAttribute("rel") || "").split(/\s+/).includes("sponsored") ||
          null,
        renderHTML: () => ({}),
      },
      ugc: {
        default: null,
        parseHTML: (el: HTMLElement) =>
          (el.getAttribute("rel") || "").split(/\s+/).includes("ugc") || null,
        renderHTML: () => ({}),
      },
    }
  },
}).configure({ openOnClick: false, HTMLAttributes: {} })

/**
 * The TipTap half of a rich-text profile (ADR-0009). Built straight from
 * {@link PROFILE_SPECS} so the editor, the `generateHTML` render path, and the
 * pure write-path allowlist all describe the same set of nodes/marks. The guard
 * that they truly match lives in `extensions.test.ts`.
 *
 * Schema-neutral editor concerns (undo/redo, placeholders) are NOT added here —
 * they don't contribute nodes/marks and belong to editor instantiation only.
 */
export function extensionsForProfile(profile: RichTextProfile): Extensions {
  return extensionsForSpec(PROFILE_SPECS[profile])
}

/** Schema-ready extension list for a field contract; not adopted by editors in D1. */
export function extensionsForContract(contract: FieldContract): Extensions {
  return extensionsForSpec(contractSpec(contract)).map((extension) =>
    contract === "title" && extension.name === "doc"
      ? extension.extend({ content: "heading" })
      : extension
  )
}

function extensionsForSpec(
  spec: (typeof PROFILE_SPECS)[RichTextProfile]
): Extensions {
  const { nodes, marks, headingLevels } = spec
  const exts: Extensions = [Document, Text] // structural, every profile

  if (nodes.has("paragraph")) exts.push(Paragraph)
  if (nodes.has("hardBreak")) exts.push(HardBreak)
  if (nodes.has("heading")) {
    exts.push(
      Heading.configure({
        levels: [...headingLevels] as (1 | 2 | 3 | 4 | 5 | 6)[],
      })
    )
  }
  if (nodes.has("bulletList")) exts.push(BulletList)
  if (nodes.has("orderedList")) exts.push(OrderedList)
  if (nodes.has("listItem")) exts.push(ListItem)
  if (nodes.has("blockquote")) exts.push(Blockquote)
  if (nodes.has("codeBlock")) exts.push(CodeBlock)
  if (nodes.has("horizontalRule")) exts.push(HorizontalRule)
  if (nodes.has("image")) exts.push(Image)
  // Tables (ADR-0009 amendment): `resizable` is editor-only and doesn't affect
  // the node schema. No HTMLAttributes class — table styling is a CSS concern
  // owned by the public renderer (CLAUDE.md "Presentation layer = CSS only").
  if (nodes.has("table")) exts.push(Table.configure({ resizable: true }))
  if (nodes.has("tableRow")) exts.push(TableRow)
  if (nodes.has("tableHeader")) exts.push(TableHeader)
  if (nodes.has("tableCell")) exts.push(TableCell)

  if (marks.has("bold")) exts.push(Bold)
  if (marks.has("italic")) exts.push(Italic)
  if (marks.has("strike")) exts.push(Strike)
  if (marks.has("underline")) exts.push(Underline)
  if (marks.has("highlight")) exts.push(Highlight)
  if (marks.has("subscript")) exts.push(Subscript)
  if (marks.has("superscript")) exts.push(Superscript)
  if (marks.has("code")) exts.push(Code)
  if (marks.has("link")) exts.push(ConfiguredLink)

  return exts
}
