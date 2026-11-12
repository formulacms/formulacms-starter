/**
 * Minimal JSX structure scanner for the visual tweak write layer (ADR-0030).
 *
 * The renderers we edit are small, hand-authored Server Components with a
 * regular shape (one root element, content leaves rendered as `{primary.<field>}`).
 * Two write-layer needs go beyond a flat substring scan and require the element
 * *nesting*:
 *
 *  - mapping a container path like `primary` to the element that wraps all of a
 *    slice's `{primary.*}` leaves (their lowest common ancestor), and
 *  - walking from a resolved element up to the nearest ancestor that actually
 *    carries a spacing utility — the ADR's "nearest ancestor owning the axis"
 *    (the read side highlights the inner content LCA, but `py-section` lives on
 *    the `<section>` one level up).
 *
 * A full TS/JSX parser is overkill (and a heavy dep) for files this small and
 * regular. This scanner tracks just enough: open / close / self-closing element
 * tags, string- and brace-aware so `className={cn(...)}` and `{primary.title}`
 * never make a `<`/`>` read as a tag boundary.
 *
 * It is deliberately NOT a general JSX parser. It assumes well-formed source
 * (the gate — typecheck + `verify-slice` — already guarantees that, and every
 * write is rolled back if the gate fails, so a mis-scan can never ship). Text
 * children are assumed to be `{expr}` rather than literal prose, so only `"` and
 * backtick strings are skipped in element-body position; inside a tag's own
 * attributes all quote styles and `{...}` are skipped.
 */

export interface JsxNode {
  /** Index of the opening `<`. */
  tagStart: number
  /** Index just past the `>` that closes the *open* tag. */
  tagEnd: number
  /** Index just past the element's full span: its `</name>` close, or `tagEnd`
   *  when self-closing. The element occupies `[tagStart, endIndex)`. */
  endIndex: number
  /** Tag name (`section`, `div`, `RichText`, `KitImage`); `""` for a fragment `<>`. */
  name: string
  selfClosing: boolean
  parent: JsxNode | null
  children: JsxNode[]
}

const QUOTES = new Set(['"', "'", "`"])

/** Advance past a string literal that starts at `i` (a quote char), honouring
 *  backslash escapes. Returns the index just past the closing quote. */
function skipString(source: string, i: number): number {
  const quote = source[i]
  let j = i + 1
  while (j < source.length) {
    const c = source[j]
    if (c === "\\") {
      j += 2
      continue
    }
    if (c === quote) return j + 1
    j += 1
  }
  return j
}

/** From the `<` at `openLt`, find the index of the `>` that closes the open tag,
 *  skipping strings and balanced `{...}` inside the tag (so a `>` living in an
 *  attribute expression like `className={cn(a > b)}` is not mistaken for the
 *  tag close). Returns -1 if unterminated. */
function findTagClose(source: string, openLt: number): number {
  let i = openLt + 1
  let braceDepth = 0
  while (i < source.length) {
    const c = source[i]
    if (c === "/" && source[i + 1] === "/") {
      const newline = source.indexOf("\n", i + 2)
      i = newline === -1 ? source.length : newline + 1
      continue
    }
    if (QUOTES.has(c)) {
      i = skipString(source, i)
      continue
    }
    if (c === "{") {
      braceDepth += 1
      i += 1
      continue
    }
    if (c === "}") {
      braceDepth = Math.max(0, braceDepth - 1)
      i += 1
      continue
    }
    if (c === ">" && braceDepth === 0) return i
    i += 1
  }
  return -1
}

const TAG_NAME_START = /[A-Za-z]/

/** Read a tag name starting at `i` (just past `<` or `</`). Returns `""` for a
 *  fragment (`<>` / `</>`). */
function readTagName(source: string, i: number): string {
  let j = i
  while (j < source.length && /[\w.]/.test(source[j])) j += 1
  return source.slice(i, j)
}

/**
 * Parse `source` into a JSX element tree. Only element tags are represented;
 * expressions and text are not nodes. Returns the list of root elements (usually
 * one) — walk `.children` / `.parent` from there.
 */
export function buildJsxTree(source: string): JsxNode[] {
  const roots: JsxNode[] = []
  const stack: JsxNode[] = []
  let i = 0

  while (i < source.length) {
    const c = source[i]

    // In element-body position, skip only double / backtick strings — a literal
    // apostrophe in prose ("don't") must not open a string. Attribute strings
    // are handled inside findTagClose, which skips all quote styles.
    if (c === '"' || c === "`") {
      i = skipString(source, i)
      continue
    }

    if (c !== "<") {
      i += 1
      continue
    }

    // Closing tag `</name>` — pop the current element.
    if (source[i + 1] === "/") {
      const gt = source.indexOf(">", i)
      const close = gt === -1 ? source.length : gt + 1
      const node = stack.pop()
      if (node) node.endIndex = close
      i = close
      continue
    }

    // Only treat `<` as a tag when it starts an element or a fragment; a stray
    // `a < b` (less-than) is followed by whitespace/operand, not a name or `>`.
    const next = source[i + 1]
    if (!TAG_NAME_START.test(next) && next !== ">") {
      i += 1
      continue
    }

    const tagClose = findTagClose(source, i)
    if (tagClose === -1) break
    const selfClosing = source[tagClose - 1] === "/"
    const name = next === ">" ? "" : readTagName(source, i + 1)
    const node: JsxNode = {
      tagStart: i,
      tagEnd: tagClose + 1,
      endIndex: tagClose + 1,
      name,
      selfClosing,
      parent: stack[stack.length - 1] ?? null,
      children: [],
    }
    ;(node.parent ? node.parent.children : roots).push(node)
    if (!selfClosing) stack.push(node)
    i = tagClose + 1
  }

  return roots
}

/** The renderer's root element: the first root node (the `<section>` after
 *  `return (`). */
export function rootNode(source: string): JsxNode | null {
  const roots = buildJsxTree(source)
  const returned = /\breturn\s*\(/.exec(source)
  if (!returned) return roots[0] ?? null
  const returnBodyStart = returned.index + returned[0].length
  return roots.find((root) => root.tagStart >= returnBodyStart) ?? null
}

/** The deepest element whose full span `[tagStart, endIndex)` contains `index`.
 *  Used to find the element directly enclosing a `{expr}` at `index`. */
export function elementAt(roots: JsxNode[], index: number): JsxNode | null {
  let found: JsxNode | null = null
  const visit = (nodes: JsxNode[]) => {
    for (const n of nodes) {
      if (index >= n.tagStart && index < n.endIndex) {
        found = n
        visit(n.children)
      }
    }
  }
  visit(roots)
  return found
}

/** `node` and its ancestors, innermost first. */
export function selfAndAncestors(node: JsxNode): JsxNode[] {
  const chain: JsxNode[] = []
  for (let n: JsxNode | null = node; n; n = n.parent) chain.push(n)
  return chain
}

/** Lowest common ancestor of a set of nodes, or `null` if empty. */
export function lowestCommonAncestor(nodes: JsxNode[]): JsxNode | null {
  if (nodes.length === 0) return null
  let ancestors = selfAndAncestors(nodes[0])
  for (const node of nodes.slice(1)) {
    const set = new Set(selfAndAncestors(node))
    ancestors = ancestors.filter((a) => set.has(a))
    if (ancestors.length === 0) return null
  }
  return ancestors[0] ?? null
}
