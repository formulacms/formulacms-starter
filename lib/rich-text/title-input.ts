import { Extension } from "@tiptap/core"
import {
  Fragment,
  Slice,
  type Node as PMNode,
  type Schema,
} from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"

/**
 * The one input rule for a title field (field contract `title`), shared by the
 * form editor and the preview inline editor. A title is one heading line with
 * no line break (ADR-0055 amendment, owner 2026-11-04):
 *  - Enter, Shift+Enter and Mod+Enter insert nothing;
 *  - a paste or drop joins every paragraph, line and break into one line with
 *    single spaces, and no word is lost;
 *  - marks the title contract does not allow (links) are dropped by the editor
 *    schema, and their words stay (owner 2026-11-03, prototype 4089ddeb);
 *  - a transaction that would add a break or a second block is rejected, which
 *    covers mobile keyboards and IME input that bypass key handlers.
 */

/**
 * A title has no blocks. Take the slice ProseMirror's own parser built (it keeps
 * every word of any paste, HTML or plain) and join it into one line: each
 * block boundary or break becomes one space, whitespace runs collapse and both
 * ends are trimmed. Inline nodes and marks that survive the schema stay.
 */
export function flattenTitleSlice(slice: Slice, schema: Schema): Slice {
  const pieces: PMNode[] = []
  const space = () => void pieces.push(schema.text(" "))
  const walk = (content: Fragment) => {
    content.forEach((node) => {
      if (node.isText) pieces.push(node)
      else if (node.type.name === "hardBreak") space()
      else if (node.isInline) pieces.push(node)
      else {
        space()
        walk(node.content)
        space()
      }
    })
  }
  walk(slice.content)
  const out: PMNode[] = []
  let lastWasSpace = true
  for (const piece of pieces) {
    if (!piece.isText) {
      out.push(piece)
      lastWasSpace = false
      continue
    }
    let text = (piece.text ?? "").replace(/\s+/g, " ")
    if (lastWasSpace) text = text.replace(/^ /, "")
    if (!text) continue
    out.push(schema.text(text, piece.marks))
    lastWasSpace = text.endsWith(" ")
  }
  const last = out[out.length - 1]
  if (last?.isText && last.text?.endsWith(" ")) {
    const trimmed = last.text.slice(0, -1)
    out.pop()
    if (trimmed) out.push(schema.text(trimmed, last.marks))
  }
  return new Slice(Fragment.from(out), 0, 0)
}

const breakCount = (doc: PMNode) => {
  let count = 0
  doc.descendants((node) => {
    if (node.type.name === "hardBreak") count += 1
  })
  return count
}

/** The edit gains a break or a block. Existing ones are not this edit's doing. */
const gainsBreakOrBlock = (before: PMNode, after: PMNode) =>
  after.childCount > Math.max(before.childCount, 1) ||
  breakCount(after) > breakCount(before)

export const TitleInput = Extension.create({
  name: "titleInput",
  // Above HardBreak (Shift-Enter, Mod-Enter) and the core Enter keymap.
  priority: 1000,
  addKeyboardShortcuts() {
    const nothing = () => true
    return { Enter: nothing, "Shift-Enter": nothing, "Mod-Enter": nothing }
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("titleInput"),
        props: {
          clipboardTextParser: (text, _context, _plain, view) => {
            const line = text.replace(/\s+/g, " ").trim()
            const { schema } = view.state
            return new Slice(
              Fragment.from(line ? [schema.text(line)] : []),
              0,
              0
            )
          },
          transformPasted: (slice, view) =>
            flattenTitleSlice(slice, view.state.schema),
        },
        // Stands in for the schema on input that bypasses key handlers.
        filterTransaction: (tr) =>
          !tr.docChanged || !gainsBreakOrBlock(tr.before, tr.doc),
      }),
    ]
  },
})
