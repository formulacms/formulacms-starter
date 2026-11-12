/**
 * Span-preserving CSS structural scanner (Plan 033 Phase 0, ADR-0046).
 *
 * The design-system workspace must be able to say "this exact declaration, in
 * this cascade layer, under this selector, in this register and mode, at these
 * bytes" — and later edit only those bytes. The parked `patchRoleToken` writer
 * matched the FIRST declaration with a given custom-property name anywhere in
 * the file, which cannot express any of that (ADR-0046 context).
 *
 * So this scanner records structure and *offsets*, never a normalized model:
 * every node carries the exact `[start, end)` it occupies, and anything it
 * cannot classify becomes an opaque `raw` node rather than disappearing. The
 * invariant the tests enforce is total coverage — every non-whitespace byte of
 * the source belongs to exactly one node — which is what makes byte-for-byte
 * preservation of unknown owner syntax provable rather than assumed
 * (Plan 033 stop condition #2).
 *
 * It is deliberately NOT a CSS engine: no specificity, no cascade resolution,
 * no value parsing beyond `var()` references. It also carries no dependency —
 * `postcss` is not a direct dependency of this repo, and a value-span-first
 * scanner is what the write phase needs anyway.
 */

export interface CssScanIssue {
  /** Machine-readable reason; `unterminated-block`, `unterminated-at-rule`, … */
  code: string
  message: string
  start: number
  end: number
}

interface CssNodeShared {
  /** Byte offset of the node's first character. */
  start: number
  /** Byte offset just past the node's last character (its `;`, `}`, or EOF). */
  end: number
}

/** `/* … *\/` — kept as a node so a diff can never drop owner commentary. */
export interface CssComment extends CssNodeShared {
  kind: "comment"
  text: string
}

/** An at-rule with no block: `@import "x";`, `@layer a, b;`, `@apply p-4;`. */
export interface CssAtStatement extends CssNodeShared {
  kind: "at-statement"
  name: string
  params: string
  paramsStart: number
  paramsEnd: number
}

/** An at-rule with a block: `@layer public-tokens { … }`, `@media … { … }`. */
export interface CssAtBlock extends CssNodeShared {
  kind: "at-block"
  name: string
  params: string
  paramsStart: number
  paramsEnd: number
  /** Just past the opening `{`. */
  bodyStart: number
  /** Index of the closing `}` (or of the source end when unterminated). */
  bodyEnd: number
  children: CssNode[]
}

export interface CssRule extends CssNodeShared {
  kind: "rule"
  selector: string
  selectorStart: number
  selectorEnd: number
  bodyStart: number
  bodyEnd: number
  children: CssNode[]
}

export interface CssDeclaration extends CssNodeShared {
  kind: "declaration"
  property: string
  propertyStart: number
  propertyEnd: number
  /** The value with surrounding whitespace and any `!important` removed. */
  value: string
  valueStart: number
  valueEnd: number
  important: boolean
  /** False when the declaration ran into `}` or EOF without its `;`. */
  terminated: boolean
}

/** Source this scanner could not classify. Never merged, never dropped. */
export interface CssRaw extends CssNodeShared {
  kind: "raw"
  text: string
}

export type CssNode =
  CssComment | CssAtStatement | CssAtBlock | CssRule | CssDeclaration | CssRaw

export interface CssScan {
  source: string
  nodes: CssNode[]
  issues: CssScanIssue[]
}

const AT_NAME = /^[A-Za-z][A-Za-z0-9-]*/

export function scanCss(source: string): CssScan {
  const issues: CssScanIssue[] = []
  const nodes = scanBlock(source, 0, source.length, issues)
  return { source, nodes, issues }
}

function scanBlock(
  source: string,
  from: number,
  to: number,
  issues: CssScanIssue[]
): CssNode[] {
  const nodes: CssNode[] = []
  let i = from
  while (i < to) {
    const ch = source[i]
    if (isSpace(ch)) {
      i += 1
      continue
    }
    if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2)
      const end = close === -1 ? to : Math.min(close + 2, to)
      if (close === -1) {
        issues.push({
          code: "unterminated-comment",
          message: "Comment is not closed.",
          start: i,
          end,
        })
      }
      nodes.push({
        kind: "comment",
        start: i,
        end,
        text: source.slice(i, end),
      })
      i = end
      continue
    }
    const node = scanStatement(source, i, to, issues)
    nodes.push(node)
    i = node.end
  }
  return nodes
}

function scanStatement(
  source: string,
  start: number,
  to: number,
  issues: CssScanIssue[]
): CssNode {
  if (source[start] === "@") {
    return scanAtRule(source, start, to, issues)
  }
  return scanRuleOrDeclaration(source, start, to, issues)
}

function scanAtRule(
  source: string,
  start: number,
  to: number,
  issues: CssScanIssue[]
): CssNode {
  const nameMatch = AT_NAME.exec(source.slice(start + 1, to))
  const name = nameMatch ? nameMatch[0] : ""
  const paramsFrom = start + 1 + name.length
  const stop = scanUntil(source, paramsFrom, to)

  if (stop.terminator === "{") {
    const bodyStart = stop.index + 1
    const close = findBlockEnd(source, bodyStart, to)
    if (close === -1) {
      issues.push({
        code: "unterminated-block",
        message: `At-rule @${name} block is not closed.`,
        start,
        end: to,
      })
    }
    const bodyEnd = close === -1 ? to : close
    const params = trimSpan(source, paramsFrom, stop.index)
    return {
      kind: "at-block",
      start,
      end: close === -1 ? to : close + 1,
      name,
      params: source.slice(params.start, params.end),
      paramsStart: params.start,
      paramsEnd: params.end,
      bodyStart,
      bodyEnd,
      children: scanBlock(source, bodyStart, bodyEnd, issues),
    }
  }

  if (stop.terminator !== ";") {
    issues.push({
      code: "unterminated-at-rule",
      message: `At-rule @${name} has no terminator.`,
      start,
      end: stop.index,
    })
  }
  const end = stop.terminator === ";" ? stop.index + 1 : stop.index
  const params = trimSpan(source, paramsFrom, stop.index)
  return {
    kind: "at-statement",
    start,
    end,
    name,
    params: source.slice(params.start, params.end),
    paramsStart: params.start,
    paramsEnd: params.end,
  }
}

function scanRuleOrDeclaration(
  source: string,
  start: number,
  to: number,
  issues: CssScanIssue[]
): CssNode {
  const stop = scanUntil(source, start, to)

  if (stop.terminator === "{") {
    // A custom property may legally hold a brace block (`--x: { a: b };`), so a
    // `{` only opens a rule when no top-level `:` came first on a `--` name.
    const colon = topLevelColon(source, start, stop.index)
    const looksLikeCustomProperty =
      colon !== -1 && source.slice(start, colon).trim().startsWith("--")
    if (!looksLikeCustomProperty) {
      const bodyStart = stop.index + 1
      const close = findBlockEnd(source, bodyStart, to)
      if (close === -1) {
        issues.push({
          code: "unterminated-block",
          message: "Rule block is not closed.",
          start,
          end: to,
        })
      }
      const bodyEnd = close === -1 ? to : close
      const selector = trimSpan(source, start, stop.index)
      return {
        kind: "rule",
        start,
        end: close === -1 ? to : close + 1,
        selector: source.slice(selector.start, selector.end),
        selectorStart: selector.start,
        selectorEnd: selector.end,
        bodyStart,
        bodyEnd,
        children: scanBlock(source, bodyStart, bodyEnd, issues),
      }
    }
    // Custom property with a block value: consume the block, then its `;`.
    const close = findBlockEnd(source, stop.index + 1, to)
    const afterBlock = close === -1 ? to : close + 1
    const semi = nextNonSpace(source, afterBlock, to)
    const end = semi !== -1 && source[semi] === ";" ? semi + 1 : afterBlock
    return declaration(source, start, end, colon, end > afterBlock, issues)
  }

  const contentEnd = stop.index
  const colon = topLevelColon(source, start, contentEnd)
  if (colon === -1) {
    const trimmed = trimSpan(source, start, contentEnd)
    const end = stop.terminator === ";" ? stop.index + 1 : stop.index
    issues.push({
      code: "unparsed-source",
      message: "Source is neither a rule nor a declaration.",
      start,
      end,
    })
    return {
      kind: "raw",
      start,
      end,
      text: source.slice(trimmed.start, trimmed.end),
    }
  }

  const end = stop.terminator === ";" ? stop.index + 1 : stop.index
  return declaration(source, start, end, colon, stop.terminator === ";", issues)
}

function declaration(
  source: string,
  start: number,
  end: number,
  colon: number,
  terminated: boolean,
  issues: CssScanIssue[]
): CssDeclaration {
  const property = trimSpan(source, start, colon)
  const rawValueEnd = terminated ? end - 1 : end
  let value = trimSpan(source, colon + 1, rawValueEnd)
  const important = /!\s*important\s*$/i.test(
    source.slice(value.start, value.end)
  )
  if (important) {
    const withoutBang = source
      .slice(value.start, value.end)
      .replace(/!\s*important\s*$/i, "")
    value = trimSpan(source, value.start, value.start + withoutBang.length)
  }
  if (value.end === value.start) {
    issues.push({
      code: "empty-value",
      message: "Declaration has no value.",
      start,
      end,
    })
  }
  return {
    kind: "declaration",
    start,
    end,
    property: source.slice(property.start, property.end),
    propertyStart: property.start,
    propertyEnd: property.end,
    value: source.slice(value.start, value.end),
    valueStart: value.start,
    valueEnd: value.end,
    important,
    terminated,
  }
}

interface ScanStop {
  /** Index of the terminator, or `to` when the range ran out. */
  index: number
  terminator: ";" | "{" | "}" | null
}

/**
 * Advance to the next top-level `;`, `{`, or `}` — skipping comments, quoted
 * strings, and balanced `()` / `[]` so `@media (min-width: 48rem)`,
 * `url(a;b)`, and `[&>:nth-child(1)]` never terminate early.
 */
function scanUntil(source: string, from: number, to: number): ScanStop {
  let i = from
  let round = 0
  let square = 0
  while (i < to) {
    const ch = source[i]
    if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2)
      i = close === -1 ? to : close + 2
      continue
    }
    if (ch === '"' || ch === "'") {
      i = skipString(source, i, to)
      continue
    }
    if (ch === "(") round += 1
    else if (ch === ")") round = Math.max(0, round - 1)
    else if (ch === "[") square += 1
    else if (ch === "]") square = Math.max(0, square - 1)
    else if (round === 0 && square === 0) {
      if (ch === ";" || ch === "{" || ch === "}") {
        return { index: i, terminator: ch }
      }
    }
    i += 1
  }
  return { index: to, terminator: null }
}

/** Index of the `}` closing the block that starts at `bodyStart`, or -1. */
function findBlockEnd(source: string, bodyStart: number, to: number): number {
  let depth = 0
  let i = bodyStart
  while (i < to) {
    const ch = source[i]
    if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2)
      i = close === -1 ? to : close + 2
      continue
    }
    if (ch === '"' || ch === "'") {
      i = skipString(source, i, to)
      continue
    }
    if (ch === "{") depth += 1
    else if (ch === "}") {
      if (depth === 0) return i
      depth -= 1
    }
    i += 1
  }
  return -1
}

function skipString(source: string, from: number, to: number): number {
  const quote = source[from]
  let i = from + 1
  while (i < to) {
    const ch = source[i]
    if (ch === "\\") {
      i += 2
      continue
    }
    if (ch === quote) return i + 1
    i += 1
  }
  return to
}

/** Index of the first `:` outside parens/brackets/strings, or -1. */
function topLevelColon(source: string, from: number, to: number): number {
  let i = from
  let round = 0
  let square = 0
  while (i < to) {
    const ch = source[i]
    if (ch === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2)
      i = close === -1 ? to : close + 2
      continue
    }
    if (ch === '"' || ch === "'") {
      i = skipString(source, i, to)
      continue
    }
    if (ch === "(") round += 1
    else if (ch === ")") round = Math.max(0, round - 1)
    else if (ch === "[") square += 1
    else if (ch === "]") square = Math.max(0, square - 1)
    else if (ch === ":" && round === 0 && square === 0) return i
    i += 1
  }
  return -1
}

function nextNonSpace(source: string, from: number, to: number): number {
  for (let i = from; i < to; i += 1) {
    if (!isSpace(source[i])) return i
  }
  return -1
}

function trimSpan(
  source: string,
  from: number,
  to: number
): { start: number; end: number } {
  let start = from
  let end = Math.max(from, to)
  while (start < end && isSpace(source[start])) start += 1
  while (end > start && isSpace(source[end - 1])) end -= 1
  return { start, end }
}

function isSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f"
}

/** Depth-first walk over a scan, parents before children. */
export function walkCss(
  nodes: CssNode[],
  visit: (node: CssNode, ancestors: CssNode[]) => void,
  ancestors: CssNode[] = []
): void {
  for (const node of nodes) {
    visit(node, ancestors)
    if (node.kind === "rule" || node.kind === "at-block") {
      walkCss(node.children, visit, [...ancestors, node])
    }
  }
}

/**
 * Every `var(--name)` referenced by a value, in source order, deduped.
 * Nested `var(--a, var(--b))` fallbacks are included.
 */
export function referencedVariables(value: string): string[] {
  const found: string[] = []
  const re = /var\(\s*(--[A-Za-z0-9_-]+)/g
  let match = re.exec(value)
  while (match) {
    if (!found.includes(match[1])) found.push(match[1])
    match = re.exec(value)
  }
  return found
}

/**
 * Replace the exact bytes of one span. The single primitive the later write
 * phase needs, kept here so Phase 0 can prove span identity without shipping a
 * writer: every byte outside `[start, end)` is preserved by construction.
 */
export function replaceSpan(
  source: string,
  start: number,
  end: number,
  next: string
): string {
  return source.slice(0, start) + next + source.slice(end)
}
