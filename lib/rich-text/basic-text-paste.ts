import { Extension } from "@tiptap/core"
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model"
import { Plugin } from "@tiptap/pm/state"

/** Shared by the sidebar, preview island and public basic-field renderer. */
export const BASIC_PARAGRAPH_GAP = "[&>p]:m-0 [&>p+p]:mt-[0.75em]"

/** Tidy only top-level pasted paragraphs; other nodes retain their content. */
export function tidyBasicPaste(
  slice: Slice,
  { fromEditorCopy }: { fromEditorCopy: boolean }
): Slice {
  const blocks: PMNode[] = []
  let firstRetained = -1
  let lastRetained = -1
  function retain(node: PMNode, index: number) {
    if (firstRetained === -1) firstRetained = index
    lastRetained = index
    blocks.push(node)
  }
  slice.content.forEach((node, _offset, index) => {
    if (node.type.name !== "paragraph") {
      retain(node, index)
      return
    }
    const children: PMNode[] = []
    node.content.forEach((child) => children.push(child))
    while (children[0]?.type.name === "hardBreak") children.shift()
    while (children.at(-1)?.type.name === "hardBreak") children.pop()
    const meaningful = children.some((child) =>
      child.isText
        ? /\S/.test(child.text ?? "")
        : child.type.name !== "hardBreak"
    )
    if (meaningful) retain(node.copy(Fragment.fromArray(children)), index)
  })
  if (!blocks.length) return Slice.empty
  const opened = Slice.maxOpen(Fragment.fromArray(blocks))
  if (!fromEditorCopy) return opened
  // Incoming depths belong to the original edges, not newly exposed blocks.
  return new Slice(
    opened.content,
    firstRetained === 0 ? Math.min(slice.openStart, opened.openStart) : 0,
    lastRetained === slice.content.childCount - 1
      ? Math.min(slice.openEnd, opened.openEnd)
      : 0
  )
}

/** Basic fields only: policy belongs to a real, synchronous DOM paste. */
export const BasicTextPaste = Extension.create({
  name: "basicTextPaste",
  addProseMirrorPlugins() {
    // Allocate here: Extension.create's config is shared across editors.
    let marker: { active: true; fromEditorCopy: boolean } | null = null
    return [new Plugin({
      props: {
        handleDOMEvents: {
          paste() {
            marker = { active: true, fromEditorCopy: false }
            // Async capture without usable clipboardData gets the default policy.
            queueMicrotask(() => { marker = null })
            return false
          },
          drop() {
            marker = null
            return false
          },
        },
        transformPastedHTML(html) {
          if (marker?.active) {
            const dom = new DOMParser().parseFromString(html, "text/html")
            const contextNode = dom.querySelector("[data-pm-slice]")
            marker.fromEditorCopy = !!contextNode && /^(\d+) (\d+)(?: -(\d+))? (.*)/.test(
              contextNode.getAttribute("data-pm-slice") || ""
            )
          }
          return html
        },
        clipboardTextParser(text, $context) {
          // view 1.42.9 clipboard.ts:56 accepts null to use its default parser;
          // EditorProps declares only Slice. Keep that runtime fallback narrow.
          if (!marker?.active) return null as unknown as Slice
          const schema = $context.doc.type.schema
          const lines = text.replace(/\r\n?/g, "\n").split("\n")
          const blocks: PMNode[] = []
          let content: PMNode[] = []
          function flush() {
            if (content.length)
              blocks.push(schema.nodes.paragraph.create(null, content))
            content = []
          }
          // Empty leading/trailing lines and runs of blank lines create no nodes.
          for (const line of lines) {
            if (!line.trim()) {
              flush()
              continue
            }
            if (content.length) content.push(schema.nodes.hardBreak.create())
            content.push(schema.text(line, $context.marks()))
          }
          flush()
          return Slice.maxOpen(Fragment.fromArray(blocks))
        },
        transformPasted(slice) {
          if (!marker?.active) return slice
          const { fromEditorCopy } = marker
          marker = null
          return tidyBasicPaste(slice, { fromEditorCopy })
        },
      },
    })]
  },
})
