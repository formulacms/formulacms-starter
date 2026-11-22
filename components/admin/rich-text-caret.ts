/**
 * Carries a click in the preview to the selection of the field's editor: the
 * form editor of a form-only field (rich text, or a plain input or
 * textarea), or the in-place preview editor. The page preview and the block
 * simulator both read their clicks here, and every editor applies them here.
 *
 * A click carries its click count: one click places the caret on the clicked
 * letter, a double click selects the clicked word and a triple click selects
 * the paragraph under the pointer (a title or a one-line input is one
 * paragraph: the whole field), like a browser's own triple click, so the
 * result is the same whether or not the editor had already opened. One word
 * rule (`wordRangeAt`) serves every editor.
 *
 * Both sides count the same plain text: each text block (paragraph, heading,
 * code block) adds one character before its content, and text adds its
 * length. Line breaks, images and list markers add nothing.
 */
import type { Editor } from "@tiptap/core"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"


const PREVIEW_TEXT_BLOCKS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "PRE",
])
const PREVIEW_TEXT_BLOCK_SELECTOR = [...PREVIEW_TEXT_BLOCKS].join(",")

/** 1 = caret, 2 = word, 3 = paragraph (a textarea: the line). */
export type PreviewClickCount = 1 | 2 | 3

/**
 * How long after the last click of a preview click sequence the page editor
 * waits before anything that moves the preview: bringing a form field into
 * view, or showing or hiding a preview refusal notice. The form and the
 * preview share one scroller, so a move during the sequence would put the
 * next click on another line.
 */
export const PREVIEW_CLICK_SETTLE_MS = 500

/**
 * A preview click: its viewport point, its click count and, when known, its
 * text offset (read at click time, before anything can move the text).
 */
export type PreviewClickPoint = {
  left: number
  top: number
  textOffset?: number
  clickCount?: PreviewClickCount
}

/** The click count of a mouse event's `detail`; more than three acts as three. */
export function previewClickCount(detail: number): PreviewClickCount {
  return detail >= 3 ? 3 : detail === 2 ? 2 : 1
}

/**
 * Reads a pointer click on a field host. Undefined for a keyboard
 * activation (`detail` 0), which has no point and keeps the editor default.
 */
export function readPreviewClick(
  host: HTMLElement,
  event: { detail: number; clientX: number; clientY: number }
): PreviewClickPoint | undefined {
  if (event.detail <= 0) return undefined
  const textOffset = previewTextOffsetFromPoint(
    host,
    event.clientX,
    event.clientY
  )
  return {
    left: event.clientX,
    top: event.clientY,
    clickCount: previewClickCount(event.detail),
    ...(textOffset !== undefined ? { textOffset } : {}),
  }
}

/** A later click of the same double or triple click, while the editor mounts:
 * it raises the pending click count and keeps the first click's spot. */
export function nextPendingClick(
  pending: PreviewClickPoint | undefined,
  next: PreviewClickPoint | undefined
): PreviewClickPoint | undefined {
  if (!pending || !next) return next ?? pending
  return { ...pending, clickCount: next.clickCount }
}

type TextSegment = { start: number; end: number; word: boolean }

const WORD_RUN = /[\p{L}\p{M}\p{N}]+(?:['\u2019][\p{L}\p{M}\p{N}]+)*/gu

function textSegments(text: string, useSegmenter: boolean): TextSegment[] {
  if (useSegmenter && typeof Intl.Segmenter === "function")
    return [
      ...new Intl.Segmenter(undefined, { granularity: "word" }).segment(text),
    ].map(({ segment, index, isWordLike }) => ({
      start: index,
      end: index + segment.length,
      word: Boolean(isWordLike),
    }))
  // Without Intl.Segmenter: runs of letters and digits, joined by an
  // apostrophe between letters (l'été); between them, each run of spaces
  // and each other character is its own segment, as with the segmenter.
  const segments: TextSegment[] = []
  const gap = (start: number, end: number) => {
    for (const match of text.slice(start, end).matchAll(/\s+|\S/gu))
      segments.push({
        start: start + match.index,
        end: start + match.index + match[0].length,
        word: false,
      })
  }
  let last = 0
  for (const match of text.matchAll(WORD_RUN)) {
    gap(last, match.index)
    last = match.index + match[0].length
    segments.push({ start: match.index, end: last, word: true })
  }
  gap(last, text.length)
  return segments
}

/**
 * The word a double click at caret index `index` selects, as [start, end).
 * The letter after the caret wins; at a word's right edge (a click on the
 * right half of its last letter) the word before the caret wins. Away from
 * any word, the space or punctuation at the caret is selected.
 */
export function wordRangeAt(
  text: string,
  index: number,
  options: { segmenter?: boolean } = {}
): { start: number; end: number } {
  const at = Math.max(0, Math.min(index, text.length))
  const segments = textSegments(text, options.segmenter ?? true)
  const after = segments.find((entry) => entry.start <= at && at < entry.end)
  const before = segments.find((entry) => entry.end === at && entry.end > entry.start)
  const chosen =
    (after?.word ? after : undefined) ??
    (before?.word ? before : undefined) ??
    after ??
    before
  return chosen ? { start: chosen.start, end: chosen.end } : { start: at, end: at }
}

/**
 * Text offset of a DOM boundary point inside `root`, or undefined outside.
 * A root with inline content only (a title or a one-line field) counts as
 * one text block, like the paragraph its editor wraps that content in.
 */
export function previewTextOffsetAt(
  root: Element,
  node: Node,
  offset: number
): number | undefined {
  if (!root.contains(node)) return undefined
  const isText = node.nodeType === Node.TEXT_NODE
  // An element boundary sits before its child at `offset`, or at its end.
  const stop = isText ? null : (node.childNodes[offset] ?? null)
  let passedNode = node === root
  let count = root.querySelector(PREVIEW_TEXT_BLOCK_SELECTOR) ? 0 : 1
  const walker = (root.ownerDocument ?? document).createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
  )
  for (let next = walker.nextNode(); next; next = walker.nextNode()) {
    if (isText && next === node)
      return count + Math.min(offset, (node as Text).data.length)
    if (!isText && (next === stop || (passedNode && !node.contains(next))))
      return count
    if (next === node) passedNode = true
    if (next.nodeType === Node.TEXT_NODE) count += (next as Text).data.length
    else if (PREVIEW_TEXT_BLOCKS.has((next as Element).tagName)) count += 1
  }
  return count
}

/** Text offset of a click point inside `root`, when the browser can tell. */
export function previewTextOffsetFromPoint(
  root: HTMLElement,
  x: number,
  y: number
): number | undefined {
  const doc = root.ownerDocument
  if (typeof doc.caretPositionFromPoint === "function") {
    const hit = doc.caretPositionFromPoint(x, y)
    return hit ? previewTextOffsetAt(root, hit.offsetNode, hit.offset) : undefined
  }
  if (typeof doc.caretRangeFromPoint === "function") {
    const hit = doc.caretRangeFromPoint(x, y)
    return hit
      ? previewTextOffsetAt(root, hit.startContainer, hit.startOffset)
      : undefined
  }
  return undefined
}

/** The part of a ProseMirror node this mapping reads. */
type RichTextDocNode = {
  isText: boolean
  isTextblock: boolean
  text?: string | null
  descendants(
    visit: (node: RichTextDocNode, pos: number) => boolean | void
  ): void
}

/**
 * Document position for a text offset, clamped to the last text position.
 * Undefined when the document has no text block.
 */
export function richTextPositionAtTextOffset(
  doc: RichTextDocNode,
  offset: number
): number | undefined {
  let count = 0
  let last: number | undefined
  let found: number | undefined
  doc.descendants((node, pos) => {
    if (found !== undefined) return false
    if (node.isTextblock) {
      count += 1
      last = pos + 1
      if (offset <= count) found = pos + 1
    } else if (node.isText) {
      const length = node.text?.length ?? 0
      if (offset <= count + length) found = pos + (offset - count)
      count += length
      last = pos + length
    }
  })
  return found ?? last
}

/**
 * The editor selection for a click at document position `pos`: a caret (1),
 * the word around it (2) or the text of the paragraph that holds it (3).
 */
export function richTextSelectionAtPos(
  doc: ProseMirrorNode,
  pos: number,
  clickCount: PreviewClickCount = 1
): { from: number; to: number } {
  if (clickCount === 1) return { from: pos, to: pos }
  let from: number | undefined
  let to: number | undefined
  doc.descendants((node, at) => {
    if (from !== undefined) return false
    if (!node.isTextblock) return true
    const start = at + 1
    const end = start + node.content.size
    if (pos < start || pos > end) return false
    if (clickCount === 3) {
      from = start
      to = end
      return false
    }
    // One character per position: text keeps its letters, and an inline
    // node (a line break) is one character that is never part of a word.
    let text = ""
    node.forEach((child) => {
      text += child.isText ? child.text! : "\ufffc".repeat(child.nodeSize)
    })
    const word = wordRangeAt(text, pos - start)
    from = start + word.start
    to = start + word.end
    return false
  })
  return from === undefined || to === undefined
    ? { from: pos, to: pos }
    : { from, to }
}

/**
 * Applies a click to an in-place editor: the selection at the click's text
 * offset (or, without one, at its point), then focus. Neither step scrolls,
 * so the field stays under the pointer for the next click.
 */
export function applyPreviewClickToEditor(
  editor: Editor,
  click: PreviewClickPoint | undefined
) {
  const { doc } = editor.state
  const pos =
    click?.textOffset !== undefined
      ? richTextPositionAtTextOffset(doc, click.textOffset)
      : click
        ? editor.view.posAtCoords(click)?.pos
        : undefined
  if (pos === undefined) {
    editor.commands.focus("end", { scrollIntoView: false })
    return
  }
  editor.commands.setTextSelection(
    richTextSelectionAtPos(doc, pos, click?.clickCount)
  )
  editor.commands.focus(null, { scrollIntoView: false })
}

type PlaceCaret = (offset: number, clickCount?: PreviewClickCount) => void

const caretHosts = new WeakMap<Element, PlaceCaret>()

/** Lets the form find a rich-text editor's caret from its editing surface. */
export function registerRichTextCaret(host: Element, place: PlaceCaret) {
  caretHosts.set(host, place)
  return () => {
    if (caretHosts.get(host) === place) caretHosts.delete(host)
  }
}

/** The line of `text` that holds caret index `at`, as [start, end). */
function textLineAt(text: string, at: number) {
  const next = text.indexOf("\n", at)
  return {
    start: at > 0 ? text.lastIndexOf("\n", at - 1) + 1 : 0,
    end: next === -1 ? text.length : next,
  }
}

/**
 * Focuses a plain input or textarea at the offset, with the click count's
 * caret, word or paragraph selected: an input's whole value, a textarea's
 * line around the offset. False for other elements.
 * A plain-text preview host holds inline text only, so its offset counts one
 * implicit text block first (see previewTextOffsetAt).
 */
export function placeInputCaret(
  element: Element,
  offset: number,
  clickCount: PreviewClickCount = 1
) {
  if (
    !(element instanceof HTMLInputElement) &&
    !(element instanceof HTMLTextAreaElement)
  )
    return false
  const { value } = element
  const at = Math.max(0, Math.min(offset - 1, value.length))
  const range =
    clickCount === 3
      ? element instanceof HTMLTextAreaElement
        ? textLineAt(value, at)
        : { start: 0, end: value.length }
      : clickCount === 2
        ? wordRangeAt(value, at)
        : { start: at, end: at }
  element.focus({ preventScroll: true })
  try {
    element.setSelectionRange(range.start, range.end)
  } catch {
    // Input types without a text selection (number, email) keep plain focus.
  }
  return true
}

/** Focuses the nearest registered editor at the offset; false if none. */
export function placeRichTextCaret(
  from: Element,
  offset: number,
  clickCount: PreviewClickCount = 1
) {
  for (let node: Element | null = from; node; node = node.parentElement) {
    const place = caretHosts.get(node)
    if (place) {
      place(offset, clickCount)
      return true
    }
  }
  return false
}
