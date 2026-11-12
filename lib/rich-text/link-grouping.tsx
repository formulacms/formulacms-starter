import type { ReactNode } from "react"
import type { Mark, Node } from "@tiptap/pm/model"

type RenderChild = (node: Node, parent: Node) => ReactNode
type RenderLink = (mark: Mark, children: ReactNode[]) => ReactNode

function linkMark(node: Node): Mark | undefined {
  return node.isText
    ? node.marks.find((mark) => mark.type.name === "link")
    : undefined
}

/** Return undefined when the parent has no multi-node linked run. */
export function renderLinkedChildren(
  parent: Node,
  renderChild: RenderChild,
  renderLink: RenderLink
): ReactNode[] | undefined {
  const nodes: Node[] = []
  parent.forEach((node) => nodes.push(node))

  let hasMultiNodeRun = false
  for (let index = 0; index < nodes.length;) {
    const mark = linkMark(nodes[index]!)
    if (!mark) {
      index += 1
      continue
    }
    let end = index + 1
    while (end < nodes.length) {
      const next = linkMark(nodes[end]!)
      if (!next?.eq(mark)) break
      end += 1
    }
    if (end - index > 1) {
      hasMultiNodeRun = true
      break
    }
    index = end
  }

  if (!hasMultiNodeRun) return undefined

  const children: ReactNode[] = []
  for (let index = 0; index < nodes.length;) {
    const node = nodes[index]!
    const mark = linkMark(node)
    if (!mark) {
      children.push(renderChild(node, parent))
      index += 1
      continue
    }

    const run = [node]
    let end = index + 1
    while (end < nodes.length) {
      const nextMark = linkMark(nodes[end]!)
      if (!nextMark?.eq(mark)) break
      run.push(nodes[end]!)
      end += 1
    }

    if (run.length === 1) {
      children.push(renderChild(node, parent))
    } else {
      const rendered = run.map((textNode) =>
        renderChild(
          textNode.mark(
            textNode.marks.filter((candidate) => !candidate.eq(mark))
          ),
          parent
        )
      )
      children.push(renderLink(mark, rendered))
    }
    index = end
  }

  return children
}
