import {
  CommandManager,
  type AnyExtension,
  type Node as TiptapNode,
  type ChainedCommands,
  type Editor,
  type NodeViewRendererProps,
} from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { Plugin, type EditorState, type Transaction } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import {
  bodyHeadingLevels,
  createBodyHeadingResolver,
} from "@/lib/slices/page-outline"

export type HeadingResult =
  `H${1 | 2 | 3 | 4 | 5 | 6}` | "P" | "empty" | "unavailable"

/** Position, rather than rank or node identity, owns each occurrence's level. */
export function projectInlineHeadings(doc: ProseMirrorNode, floor: number) {
  const resolve = createBodyHeadingResolver(
    bodyHeadingLevels(doc.toJSON(), floor)
  )
  const levels = new Map<number, number | null>()
  doc.descendants((node, pos) => {
    if (
      node.type.name === "heading" &&
      Number.isInteger(node.attrs.level) &&
      node.attrs.level >= 1 &&
      node.attrs.level <= 6
    )
      levels.set(pos, resolve(node.attrs.level, node.textContent))
  })
  return levels
}
export function selectedHeadingLevel(
  state: Pick<EditorState, "doc" | "selection">,
  floor: number
) {
  const { $from } = state.selection
  return $from.parent.type.name === "heading"
    ? (projectInlineHeadings(state.doc, floor).get($from.before()) ?? null)
    : null
}
export function toggleInlineHeading(
  chain: ChainedCommands,
  command: "heading" | "subheading"
) {
  return chain.toggleHeading({ level: command === "heading" ? 2 : 3 })
}
export function predictInlineHeading(
  editor: Editor,
  floor: number,
  command: "heading" | "subheading"
): HeadingResult {
  const transaction: Transaction = editor.state.tr
  const manager = new CommandManager({ editor, state: editor.state })
  if (!toggleInlineHeading(manager.createChain(transaction), command).run())
    return "unavailable"
  if (transaction.selection.$from.parent.type.name !== "heading") return "P"
  const level = selectedHeadingLevel(transaction, floor)
  return level === null ? "empty" : `H${level as 1 | 2 | 3 | 4 | 5 | 6}`
}

/** Simulator only: PM locally recreates a heading when its projected tag changes. */
export function withInlineHeadingProjection(
  extension: AnyExtension,
  floor: number
) {
  return (extension as TiptapNode).extend({
    addProseMirrorPlugins() {
      return [
        ...(this.parent?.() ?? []),
        new Plugin({
          props: {
            decorations(state) {
              const levels = projectInlineHeadings(state.doc, floor)
              const decorations: Decoration[] = []
              state.doc.descendants((node, pos) => {
                if (levels.has(pos))
                  decorations.push(
                    Decoration.node(
                      pos,
                      pos + node.nodeSize,
                      {},
                      { resolvedLevel: levels.get(pos) }
                    )
                  )
              })
              return DecorationSet.create(state.doc, decorations)
            },
          },
        }),
      ]
    },
    addNodeView() {
      return ({ decorations }: NodeViewRendererProps) => {
        const levelFor = (items: readonly Decoration[]) =>
          items.find((item) => "resolvedLevel" in item.spec)?.spec
            .resolvedLevel ?? Math.min(6, floor)
        const level = levelFor(decorations)
        const dom = document.createElement(`h${level}`)
        return {
          dom,
          contentDOM: dom,
          update(
            node: ProseMirrorNode,
            nextDecorations: readonly Decoration[]
          ) {
            return (
              node.type.name === "heading" &&
              levelFor(nextDecorations) === level
            )
          },
        }
      }
    },
  })
}
