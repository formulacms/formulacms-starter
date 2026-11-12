"use client"
import type {
  FieldContract,
  ResolvedFieldContract,
} from "@/convex/lib/richtext/contracts"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { UndoRedo } from "@tiptap/extensions/undo-redo"
import { Editor, type JSONContent } from "@tiptap/core"
import { extensionsForContract } from "@/lib/rich-text/extensions"
import { BasicTextPaste, BASIC_PARAGRAPH_GAP } from "@/lib/rich-text/basic-text-paste"
import { richTextToDocument } from "@/lib/rich-text/render"
import { cn } from "@/lib/utils"

import {
  mergeRemovedLinks,
  type RemovedRichTextLink,
} from "@/convex/lib/richtext/shape"
import { isLegacyTitleHtml } from "@/convex/lib/richtext/write"
import { parseLegacyTitle } from "@/lib/rich-text/title-write"
import { TitleInput } from "@/lib/rich-text/title-input"
import { normalizePreviewInlineDocument } from "./preview-inline-document"
import {
  withInlineHeadingProjection,
  selectedHeadingLevel,
  predictInlineHeading,
  toggleInlineHeading,
  type HeadingResult,
} from "./preview-inline-headings"

/** Capture diagnostics while parsing, before the editor's link-free title schema. */
function prepareInlineValue(
  value: string,
  contract: FieldContract,
  resolvedContract?: ResolvedFieldContract
) {
  let removedLinks: RemovedRichTextLink[] = []
  const parsed =
    contract === "title" && isLegacyTitleHtml(value)
      ? parseLegacyTitle(value)
      : null
  if (parsed) removedLinks = parsed.removedLinks
  const document = normalizePreviewInlineDocument(
    parsed
      ? JSON.parse(parsed.value)
      : richTextToDocument(value, contract === "title" ? "inline" : contract),
    contract,
    (links) => {
      removedLinks = mergeRemovedLinks(removedLinks, links)
    },
    resolvedContract
  )
  return { document, removedLinks }
}

export type PreviewInlineFormat =
  | "bold"
  | "italic"
  | "strike"
  | "underline"
  | "highlight"
  | "subscript"
  | "superscript"
  | "paragraph"
  | "bulletList"
  | "orderedList"
  | "heading"
  | "subheading"
  | "lineBreak"
export type PreviewInlineTextState = {
  block: string
  headingLevel: number | null
  relativeHeading?: "heading" | "subheading"
  marks: string[]
  headingResult?: HeadingResult
  subheadingResult?: HeadingResult
}
export type PreviewInlineController = {
  readonly historyOwnedExternally: true
  flush(): { value: string; from: number; to: number; composing: boolean }
  replay(value: string, selection?: { from: number; to: number }): void
  format(
    command: PreviewInlineFormat,
    selection?: { from: number; to: number }
  ): boolean
  textState(): PreviewInlineTextState
}
export type PreviewInlineSimulator = {
  block?: boolean
  plain?: boolean
  headingFloor?: number
  onController(controller: PreviewInlineController | null): void
  onSelection?(
    selection: { from: number; to: number },
    state: PreviewInlineTextState
  ): void
  onGroupEnd?(): void
}

export function PreviewInlineEditor({
  value,
  contract = "inline",
  resolvedContract,
  fieldPath,
  label,
  className,
  initialPoint,
  onChange,
  onCancel,
  onCommit,
  onCompositionChange,
  onFlushHandleChange,
  simulator,
  headingFloor = 2,
}: {
  value: string
  simulator?: PreviewInlineSimulator
  contract?: FieldContract
  resolvedContract?: ResolvedFieldContract
  headingFloor?: number
  fieldPath: string
  label: string
  className?: string
  initialPoint?: { left: number; top: number }
  onChange(value: string, removedLinks?: RemovedRichTextLink[]): void
  onCancel(): void
  onCommit(): void
  onCompositionChange(composing: boolean): void
  onFlushHandleChange?(flush: (() => void) | null): void
}) {
  const host = useRef<HTMLElement | null>(null)
  const [sim] = useState(() => simulator)
  const block = contract === "basic" || contract === "full" || !!sim?.block
  const floor = sim?.headingFloor ?? headingFloor
  const callbacks = useRef({
    onChange,
    onCancel,
    onCommit,
    onCompositionChange,
  })
  useLayoutEffect(() => {
    callbacks.current = { onChange, onCancel, onCommit, onCompositionChange }
  })
  const editorRef = useRef<Editor | null>(null)
  const [initialAttributes] = useState(() => ({
    value,
    label,
    className,
    fieldPath,
    initialPoint,
    // Bind descriptor shaping to this editing session, like its seed value.
    resolvedContract,
  }))
  const [seed] = useState(() =>
    sim?.plain
      ? {
          document: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: value ? [{ type: "text", text: value }] : [],
              },
            ],
          } as JSONContent,
          removedLinks: [] as RemovedRichTextLink[],
        }
      : block
        ? {
            document: richTextToDocument(
              value,
              contract === "title" ? "inline" : contract
            ),
            removedLinks: [] as RemovedRichTextLink[],
          }
        : prepareInlineValue(value, contract, initialAttributes.resolvedContract)
  )
  const removedLinks = useRef(seed.removedLinks)
  useEffect(() => {
    if (!host.current) return
    function retainLinks(links: RemovedRichTextLink[]) {
      removedLinks.current = mergeRemovedLinks(removedLinks.current, links)
    }
    const documentValue = () =>
      sim?.plain
        ? editor.getText({ blockSeparator: "\n" })
        : JSON.stringify(
            block
              ? editor.getJSON()
              : normalizePreviewInlineDocument(
                  editor.getJSON(),
                  contract,
                  retainLinks,
                  initialAttributes.resolvedContract
                )
          )
    function textState(): PreviewInlineTextState {
      const blockName = editor.isActive("bulletList")
        ? "bulletList"
        : editor.isActive("orderedList")
          ? "orderedList"
          : editor.state.selection.$from.parent.type.name
      const title = !block && host.current?.closest("h1,h2,h3,h4,h5,h6")
      const stored = editor.state.selection.$from.parent.attrs.level
      return {
        block: blockName,
        headingLevel: title
          ? Number(title.tagName.slice(1))
          : blockName === "heading"
            ? selectedHeadingLevel(editor.state, floor)
            : null,
        ...(blockName === "heading" && (stored === 2 || stored === 3)
          ? {
              relativeHeading:
                stored === 2 ? ("heading" as const) : ("subheading" as const),
            }
          : {}),
        ...(block
          ? {
              headingResult: predictInlineHeading(editor, floor, "heading"),
              subheadingResult: predictInlineHeading(
                editor,
                floor,
                "subheading"
              ),
            }
          : {}),
        marks: [
          "bold",
          "italic",
          "strike",
          "underline",
          "highlight",
          "subscript",
          "superscript",
        ].filter((mark) => editor.isActive(mark)),
      }
    }
    const isTitle = contract === "title" && !block && !sim?.plain
    const extensions = extensionsForContract(contract)
      .filter(
        (extension) =>
          (!sim?.plain || extension.type !== "mark") &&
          (!block ||
            ![
              "image",
              "table",
              "tableRow",
              "tableHeader",
              "tableCell",
            ].includes(extension.name))
      )
      .map((extension) => {
        if (
          !block &&
          (extension.name === "paragraph" || extension.name === "heading")
        )
          return extension.extend({ renderHTML: () => ["span", 0] })
        if (block && extension.name === "heading")
          return withInlineHeadingProjection(extension, floor)
        return extension
      })
    // React owns the host and Tiptap owns its descendants. Inline/title fields
    // keep a phrasing host; descriptor-owned bodies use a block host.
    const editor = new Editor({
      element: { mount: host.current },
      extensions: [
        ...extensions,
        ...(contract === "basic" ? [BasicTextPaste] : []),
        ...(isTitle ? [TitleInput] : []),
        ...(sim ? [] : [UndoRedo]),
      ],
      content: seed.document,
      injectCSS: false,
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": initialAttributes.label,
          class: cn(
            initialAttributes.className,
            contract === "basic" && BASIC_PARAGRAPH_GAP,
            "outline outline-1 outline-primary/60 outline-none"
          ),
          "data-preview-inline-editor": "",
        },
        handleKeyDown(view, event) {
          if (event.isComposing || view.composing) return false
          if (event.key === "Escape") {
            event.preventDefault()
            callbacks.current.onCancel()
            return true
          }
          // A title's Enter belongs to the shared title input rule (TitleInput).
          if (event.key === "Enter" && !block && !isTitle) {
            event.preventDefault()
            editor?.commands.setHardBreak()
            return true
          }
          return false
        },
        handleDOMEvents: {
          compositionstart() {
            callbacks.current.onCompositionChange(true)
            return false
          },
          compositionend() {
            callbacks.current.onCompositionChange(false)
            sim?.onGroupEnd?.()
            return false
          },
        },
        handlePaste(_view, event) {
          const clipboard = event.clipboardData
          if (!clipboard || !editor) return false
          if (block) return false
          if (isTitle) {
            // TitleInput shapes the pasted slice (one rule for both editors);
            // keep only the report of links its schema is about to drop.
            const pasted = clipboard.getData("text/html")
            if (pasted)
              retainLinks(
                prepareInlineValue(
                  pasted,
                  contract,
                  initialAttributes.resolvedContract
                ).removedLinks
              )
            return false
          }
          const html = sim?.plain ? "" : clipboard.getData("text/html")
          const text = clipboard.getData("text/plain")
          const parsed = html
            ? prepareInlineValue(
                html,
                contract,
                initialAttributes.resolvedContract
              )
            : null
          if (parsed) retainLinks(parsed.removedLinks)
          const document = parsed?.document ?? {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: text
                  .split(/\r?\n/)
                  .flatMap((line, index) => [
                    ...(index ? [{ type: "hardBreak" }] : []),
                    ...(line ? [{ type: "text", text: line }] : []),
                  ]),
              },
            ],
          }
          event.preventDefault()
          editor.commands.insertContent(document.content?.[0].content ?? [])
          return true
        },
      },
      onUpdate({ editor }) {
        sim?.onSelection?.(
          {
            from: editor.state.selection.from,
            to: editor.state.selection.to,
          },
          textState()
        )
        callbacks.current.onChange(documentValue(), removedLinks.current)
      },
      onSelectionUpdate({ editor }) {
        sim?.onSelection?.(
          {
            from: editor.state.selection.from,
            to: editor.state.selection.to,
          },
          textState()
        )
      },
      onBlur({ event }) {
        // Crossing into the parent document has no relatedTarget. Keep the
        // latest buffer synchronously capturable by its Save handler.
        if (event.relatedTarget === null) return
        if (
          event.relatedTarget instanceof Element &&
          event.relatedTarget.closest(
            "[data-preview-inline-editor], [data-preview-save-control]"
          )
        )
          return
        callbacks.current.onCommit()
      },
    })
    editorRef.current = editor
    const mountedDocument = editor.state.doc
    const flush = () => {
      const { from, to } = editor.state.selection
      const result = {
        // Mounting may add default link/mark attributes. An unchanged island
        // must keep the exact original field, rather than write that encoding.
        value: editor.state.doc.eq(mountedDocument)
          ? initialAttributes.value
          : documentValue(),
        from,
        to,
        composing: editor.view.composing,
      }
      callbacks.current.onCompositionChange(result.composing)
      callbacks.current.onChange(result.value, removedLinks.current)
      return result
    }
    onFlushHandleChange?.(flush)
    sim?.onController({
      historyOwnedExternally: true,
      textState,
      flush,
      replay(value, selection) {
        const content = sim.plain
          ? {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: value ? [{ type: "text", text: value }] : [],
                },
              ],
            }
          : block
            ? richTextToDocument(
                value,
                contract === "title" ? "inline" : contract
              )
            : prepareInlineValue(
                value,
                contract,
                initialAttributes.resolvedContract
              ).document
        editor.commands.setContent(content, { emitUpdate: false })
        if (selection) {
          const max = editor.state.doc.content.size
          editor.commands.setTextSelection({
            from: Math.max(0, Math.min(max, selection.from)),
            to: Math.max(0, Math.min(max, selection.to)),
          })
        }
      },
      format(command, selection) {
        if (sim.plain || editor.view.composing) return false
        sim.onGroupEnd?.()
        const chain = editor.chain()
        const completed = (result: boolean) => {
          sim.onGroupEnd?.()
          return result
        }
        if (selection) chain.setTextSelection(selection)
        chain.focus()
        // A title schema has no hardBreak (ADR-0055 one-line titles, 2026-11-04).
        if (command === "lineBreak")
          return completed(
            Boolean(editor.schema.nodes.hardBreak) && chain.setHardBreak().run()
          )
        if (command === "paragraph")
          return completed(block && chain.setParagraph().run())
        if (command === "bulletList")
          return completed(block && chain.toggleBulletList().run())
        if (command === "orderedList")
          return completed(block && chain.toggleOrderedList().run())
        if (command === "heading" || command === "subheading")
          return completed(block && toggleInlineHeading(chain, command).run())
        return completed(chain.toggleMark(command).run())
      },
    })
    // The mounted view shares the click's frame viewport. Map once, before
    // focus can scroll; later prop echoes must preserve the active selection.
    const hit = initialAttributes.initialPoint
      ? editor.view.posAtCoords(initialAttributes.initialPoint)
      : null
    editor.commands.focus(hit?.pos ?? "end")
    return () => {
      editorRef.current = null
      onFlushHandleChange?.(null)
      sim?.onController(null)
      editor.destroy()
    }
  }, [
    seed,
    initialAttributes,
    onFlushHandleChange,
    contract,
    sim,
    block,
    floor,
  ])
  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        attributes: {
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": label,
          "data-preview-inline-editor": "",
          class: cn(
            className,
            contract === "basic" && BASIC_PARAGRAPH_GAP,
            "outline outline-1 outline-primary/60"
          ),
        },
      },
    })
  }, [className, label, fieldPath, contract])

  // No prop echo into Tiptap: its active text DOM, range and history stay owned
  // by the editor until this island exits. The session projects emitted values.
  const Host = block ? "div" : "span"
  return (
    <Host
      ref={(element) => {
        host.current = element
      }}
      className={cn(
        className,
        contract === "basic" && BASIC_PARAGRAPH_GAP,
        "outline outline-1 outline-primary/60"
      )}
    />
  )
}
