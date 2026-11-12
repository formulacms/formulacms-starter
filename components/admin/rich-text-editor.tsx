"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import {
  useEditor,
  useEditorState,
  EditorContent,
  type Editor,
} from "@tiptap/react"
import { UndoRedo } from "@tiptap/extensions/undo-redo"
import {
  Bold,
  Italic,
  Strikethrough,
  Underline as UnderlineIcon,
  Highlighter,
  Subscript as SubscriptIcon,
  Superscript as SuperscriptIcon,
  Code,
  Pilcrow,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  List,
  ListOrdered,
  Quote,
  Minus,
  Undo,
  Redo,
  Table as TableIcon,
  Rows3,
  Columns3,
  ArrowUpToLine,
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  TableCellsMerge,
  Heading as HeadingIcon,
  Trash2,
  Link as LinkIcon,
  Image as ImageIcon,
  Loader2,
  PencilLine,
  Sparkles,
  Wand2,
  WandSparkles,
} from "lucide-react"
import { toast } from "sonner"
import { MediaPicker } from "./media-picker"
import {
  LinkPickerDialog,
  type LinkPickerResult,
  type LinkPickerValue,
} from "./link-picker-dialog"
import { extensionsForProfile } from "@/lib/rich-text/extensions"
import { BasicTextPaste, BASIC_PARAGRAPH_GAP } from "@/lib/rich-text/basic-text-paste"
import { TitleInput } from "@/lib/rich-text/title-input"
import {
  contractSpec,
  resolveFieldContract,
  type FieldContract,
} from "@/convex/lib/richtext/contracts"
import { toFieldShape } from "@/convex/lib/richtext/shape"
import {
  PROFILE_SPECS,
  type RichTextProfile,
} from "@/convex/lib/richtext/profiles"
import type { Id } from "@/convex/_generated/dataModel"
import { useConfirm, usePrompt } from "@/components/providers/confirm-provider"
import { fieldHasContent } from "./fields/field-utils"
import type { FieldGenerate, FieldTranslate } from "./fields/field-editor"
import { cn } from "@/lib/utils"
import { PageSaveRefusedError } from "@/components/admin/page-editor/lib/page-save-refused-error"

/** Parse a stored value into TipTap's `content`: a PM doc object, or legacy HTML. */
function toEditorContent(
  value: string,
  profile: RichTextProfile,
  contract?: FieldContract
): object | string {
  if (!value) return ""
  try {
    const parsed = JSON.parse(value)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === "doc"
    ) {
      // A title is shaped by its own contract first (links removed, blocks
      // joined by breaks), so the editor and the parent agree on its bytes.
      const shaped =
        contract === "title"
          ? toFieldShape(resolveFieldContract("title"), value).value
          : value
      return JSON.parse(
        toFieldShape(resolveFieldContract(profile), shaped).value
      )
    }
  } catch {
    // not JSON — fall through and treat as legacy HTML
  }
  return value
}

type SlashRange = { from: number; to: number }
type SlashState = SlashRange & {
  query: string
  top: number
  left: number
  emptyBlock: boolean
}

type SlashCommand = {
  id: string
  label: string
  description?: string
  icon: React.ComponentType<{ className?: string }>
  keywords?: string[]
  shortcut?: string
  disabled?: boolean
  run: () => void | Promise<void>
}

function modLabel(shortcut: string) {
  if (typeof navigator === "undefined") return shortcut.replace("Mod", "Ctrl")
  const mod = /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘" : "Ctrl"
  return shortcut.replace("Mod", mod).replace(/-/g, "+")
}

function slashScore(command: SlashCommand, query: string) {
  if (!query) return 1
  const q = query.toLowerCase()
  const label = command.label.toLowerCase()
  const haystack = [
    command.label,
    command.description,
    ...(command.keywords ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  if (label.startsWith(q)) return 4
  if (haystack.includes(q)) return 3
  return q.split(/\s+/).every((part) => haystack.includes(part)) ? 2 : 0
}

function detectSlashState(editor: Editor): SlashState | null {
  if (!editor.isFocused) return null
  if (editor.isActive("code") || editor.isActive("codeBlock")) return null

  const { selection } = editor.state
  if (!selection.empty) return null

  const { $from } = selection
  const textBefore = $from.parent.textBetween(
    0,
    $from.parentOffset,
    undefined,
    "\ufffc"
  )
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(textBefore)
  if (!match) return null

  const query = match[1] ?? ""
  const slashOffset = textBefore.length - query.length - 1
  const charBeforeSlash = slashOffset > 0 ? textBefore[slashOffset - 1] : ""
  if (charBeforeSlash && !/\s/.test(charBeforeSlash)) return null

  const from = $from.pos - query.length - 1
  const to = $from.pos
  const coords = editor.view.coordsAtPos(from)
  if (!coords) return null
  const emptyBlock = textBefore === `/${query}`

  return {
    from,
    to,
    query,
    emptyBlock,
    left: Math.max(12, Math.min(coords.left, window.innerWidth - 340)),
    top: Math.min(coords.bottom + 8, window.innerHeight - 260),
  }
}

function ToolbarButton({
  active,
  pressed,
  onClick,
  title,
  children,
}: {
  active?: boolean
  pressed?: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={pressed}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`rounded p-1.5 transition-colors ${
        (active ?? pressed)
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50"
      }`}
    >
      {children}
    </button>
  )
}

function SlashCommandMenu({
  state,
  commands,
  activeIndex,
  runningId,
  onActiveIndexChange,
  onRun,
}: {
  state: SlashState
  commands: SlashCommand[]
  activeIndex: number
  runningId: string | null
  onActiveIndexChange: (index: number) => void
  onRun: (command: SlashCommand) => void
}) {
  const t = useTranslations("editor.richText")
  return (
    <div
      role="menu"
      aria-label={t("commands")}
      style={{ top: state.top, left: state.left }}
      className="fixed z-50 w-80 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
    >
      <div className="border-b px-3 py-2">
        <p className="text-xs font-medium text-muted-foreground">
          {state.query ? `/${state.query}` : t("commands")}
        </p>
      </div>
      <div className="max-h-72 overflow-y-auto p-1.5">
        {commands.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            {t("noCommands")}
          </div>
        ) : (
          commands.map((command, index) => {
            const Icon = command.icon
            const active = index === activeIndex
            const running = runningId === command.id
            return (
              <button
                key={command.id}
                type="button"
                role="menuitem"
                disabled={command.disabled || runningId !== null}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onActiveIndexChange(index)}
                onClick={() => onRun(command)}
                className={cn(
                  "flex min-h-11 w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-45",
                  active && "bg-accent text-accent-foreground",
                  !active && "hover:bg-accent/50"
                )}
              >
                {running ? (
                  <Loader2 className="size-4 shrink-0 animate-spin" />
                ) : (
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {command.label}
                  </span>
                  {command.description && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {command.description}
                    </span>
                  )}
                </span>
                {command.shortcut && (
                  <kbd className="rounded border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
                    {command.shortcut}
                  </kbd>
                )}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

function Toolbar({
  editor,
  profile,
  contract,
}: {
  editor: Editor
  profile: RichTextProfile
  contract?: FieldContract
}) {
  const t = useTranslations("editor.richText")
  const [pickerOpen, setPickerOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkInitial, setLinkInitial] = useState<LinkPickerValue | null>(null)
  // Capture the editor selection at the moment the dialog opens; opening it
  // moves DOM focus out of the editor, and we need to restore the range before
  // applying the link mark.
  const linkSelection = useRef<{ from: number; to: number } | null>(null)
  // Buttons come from the editor's own nodes, limited to the marks the field
  // contract allows (a title has no Link button).
  const { nodes, headingLevels } = PROFILE_SPECS[profile]
  const marks = contract ? contractSpec(contract).marks : PROFILE_SPECS[profile].marks

  // useEditorState subscribes to editor transactions and re-renders this
  // component only when one of the selected booleans flips. This is the v3
  // way: `useEditor` alone no longer triggers re-renders on every transaction
  // (the v2 default was removed), so `editor.isActive(...)` read straight from
  // render would be stale — most importantly, the table contextual buttons
  // depend on `isInTable` and would never appear.
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      isParagraph: editor.isActive("paragraph"),
      isBold: editor.isActive("bold"),
      isItalic: editor.isActive("italic"),
      isStrike: editor.isActive("strike"),
      isUnderline: editor.isActive("underline"),
      isHighlight: editor.isActive("highlight"),
      isSubscript: editor.isActive("subscript"),
      isSuperscript: editor.isActive("superscript"),
      isCode: editor.isActive("code"),
      isH1: editor.isActive("heading", { level: 1 }),
      isH2: editor.isActive("heading", { level: 2 }),
      isH3: editor.isActive("heading", { level: 3 }),
      isH4: editor.isActive("heading", { level: 4 }),
      isH5: editor.isActive("heading", { level: 5 }),
      isH6: editor.isActive("heading", { level: 6 }),
      isBulletList: editor.isActive("bulletList"),
      isOrderedList: editor.isActive("orderedList"),
      isBlockquote: editor.isActive("blockquote"),
      isLink: editor.isActive("link"),
      isInTable: editor.isActive("table"),
    }),
  })

  const hasLink = state.isLink

  function openLinkPicker() {
    const attrs = editor.getAttributes("link") as Record<string, unknown>
    const pageIdAttr =
      typeof attrs.pageId === "string" && attrs.pageId.length > 0
        ? (attrs.pageId as Id<"pages">)
        : null
    const href = typeof attrs.href === "string" ? attrs.href : ""
    setLinkInitial({
      mode: pageIdAttr ? "page" : "url",
      pageId: pageIdAttr,
      url: href,
      openInNewTab: attrs.target === "_blank",
      noFollow: attrs.noFollow === true,
      sponsored: attrs.sponsored === true,
      ugc: attrs.ugc === true,
    })
    const { from, to } = editor.state.selection
    linkSelection.current = { from, to }
    setLinkOpen(true)
  }

  function applyLink(result: LinkPickerResult) {
    setLinkOpen(false)
    const sel = linkSelection.current
    if (!sel) return
    editor
      .chain()
      .focus()
      .setTextSelection(sel)
      .extendMarkRange("link")
      .setMark("link", {
        href: result.href,
        target: result.openInNewTab ? "_blank" : null,
        pageId: result.pageId,
        noFollow: result.noFollow || null,
        sponsored: result.sponsored || null,
        ugc: result.ugc || null,
      })
      .run()
  }

  function removeLink() {
    setLinkOpen(false)
    const sel = linkSelection.current
    if (!sel) return
    editor.chain().focus().setTextSelection(sel).unsetLink().run()
  }

  return (
    // Toolbar container only preventDefaults mousedown to keep editor
    // focus; it has no click/interactive behavior of its own (buttons
    // below do).
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      // preventDefault on mousedown (see ToolbarButton) keeps editor focus on click.
      onMouseDown={(e) => e.preventDefault()}
      className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 border-b bg-background px-1.5 py-1"
    >
      <ToolbarButton
        title={t("toolbar.undo")}
        onClick={() => editor.chain().focus().undo().run()}
      >
        <Undo className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        title={t("toolbar.redo")}
        onClick={() => editor.chain().focus().redo().run()}
      >
        <Redo className="size-4" />
      </ToolbarButton>
      {nodes.has("paragraph") && (
        <ToolbarButton
          title={t("toolbar.paragraph")}
          pressed={state.isParagraph}
          onClick={() => editor.chain().focus().setParagraph().run()}
        >
          <Pilcrow className="size-4" />
        </ToolbarButton>
      )}
      {marks.has("bold") && (
        <ToolbarButton
          title={t("toolbar.withShortcut", {
            action: t("toolbar.bold"),
            shortcut: modLabel("Mod-b"),
          })}
          pressed={state.isBold}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold className="size-4" />
        </ToolbarButton>
      )}
      {marks.has("italic") && (
        <ToolbarButton
          title={t("toolbar.withShortcut", {
            action: t("toolbar.italic"),
            shortcut: modLabel("Mod-i"),
          })}
          pressed={state.isItalic}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic className="size-4" />
        </ToolbarButton>
      )}
      {marks.has("underline") && (
        <ToolbarButton
          title={t("toolbar.withShortcut", {
            action: t("toolbar.underline"),
            shortcut: modLabel("Mod-u"),
          })}
          pressed={state.isUnderline}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        >
          <UnderlineIcon className="size-4" />
        </ToolbarButton>
      )}
      {marks.has("strike") && (
        <ToolbarButton
          title={t("toolbar.withShortcut", {
            action: t("toolbar.strikethrough"),
            shortcut: modLabel("Mod-Shift-s"),
          })}
          pressed={state.isStrike}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <Strikethrough className="size-4" />
        </ToolbarButton>
      )}
      {marks.has("highlight") && (
        <ToolbarButton
          title={t("toolbar.withShortcut", {
            action: t("toolbar.highlight"),
            shortcut: modLabel("Mod-Shift-h"),
          })}
          pressed={state.isHighlight}
          onClick={() => editor.chain().focus().toggleHighlight().run()}
        >
          <Highlighter className="size-4" />
        </ToolbarButton>
      )}
      {marks.has("subscript") && (
        <ToolbarButton
          title={t("toolbar.withShortcut", {
            action: t("toolbar.subscript"),
            shortcut: modLabel("Mod-,"),
          })}
          pressed={state.isSubscript}
          onClick={() => editor.chain().focus().toggleSubscript().run()}
        >
          <SubscriptIcon className="size-4" />
        </ToolbarButton>
      )}
      {marks.has("superscript") && (
        <ToolbarButton
          title={t("toolbar.withShortcut", {
            action: t("toolbar.superscript"),
            shortcut: modLabel("Mod-."),
          })}
          pressed={state.isSuperscript}
          onClick={() => editor.chain().focus().toggleSuperscript().run()}
        >
          <SuperscriptIcon className="size-4" />
        </ToolbarButton>
      )}
      {marks.has("code") && (
        <ToolbarButton
          title={t("toolbar.withShortcut", {
            action: t("toolbar.inlineCode"),
            shortcut: modLabel("Mod-e"),
          })}
          pressed={state.isCode}
          onClick={() => editor.chain().focus().toggleCode().run()}
        >
          <Code className="size-4" />
        </ToolbarButton>
      )}
      {nodes.has("heading") && headingLevels.has(2) && (
        <ToolbarButton
          title={t("toolbar.withShortcut", {
            action: t("toolbar.heading", { level: 2 }),
            shortcut: modLabel("Mod-Alt-2"),
          })}
          pressed={state.isH2}
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 2 }).run()
          }
        >
          <Heading2 className="size-4" />
        </ToolbarButton>
      )}
      {nodes.has("heading") && headingLevels.has(3) && (
        <ToolbarButton
          title={t("toolbar.withShortcut", {
            action: t("toolbar.heading", { level: 3 }),
            shortcut: modLabel("Mod-Alt-3"),
          })}
          pressed={state.isH3}
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 3 }).run()
          }
        >
          <Heading3 className="size-4" />
        </ToolbarButton>
      )}
      {nodes.has("heading") && headingLevels.has(4) && (
        <ToolbarButton
          title={t("toolbar.withShortcut", {
            action: t("toolbar.heading", { level: 4 }),
            shortcut: modLabel("Mod-Alt-4"),
          })}
          pressed={state.isH4}
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 4 }).run()
          }
        >
          <Heading4 className="size-4" />
        </ToolbarButton>
      )}
      {nodes.has("heading") && headingLevels.has(5) && (
        <ToolbarButton
          title={t("toolbar.withShortcut", {
            action: t("toolbar.heading", { level: 5 }),
            shortcut: modLabel("Mod-Alt-5"),
          })}
          pressed={state.isH5}
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 5 }).run()
          }
        >
          <Heading5 className="size-4" />
        </ToolbarButton>
      )}
      {nodes.has("heading") && headingLevels.has(6) && (
        <ToolbarButton
          title={t("toolbar.withShortcut", {
            action: t("toolbar.heading", { level: 6 }),
            shortcut: modLabel("Mod-Alt-6"),
          })}
          pressed={state.isH6}
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 6 }).run()
          }
        >
          <Heading6 className="size-4" />
        </ToolbarButton>
      )}
      {nodes.has("bulletList") && (
        <ToolbarButton
          title={t("toolbar.withShortcut", {
            action: t("toolbar.bulletList"),
            shortcut: modLabel("Mod-Shift-8"),
          })}
          pressed={state.isBulletList}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List className="size-4" />
        </ToolbarButton>
      )}
      {nodes.has("orderedList") && (
        <ToolbarButton
          title={t("toolbar.withShortcut", {
            action: t("toolbar.numberedList"),
            shortcut: modLabel("Mod-Shift-7"),
          })}
          pressed={state.isOrderedList}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered className="size-4" />
        </ToolbarButton>
      )}
      {nodes.has("blockquote") && (
        <ToolbarButton
          title={t("toolbar.withShortcut", {
            action: t("toolbar.blockquote"),
            shortcut: modLabel("Mod-Shift-b"),
          })}
          pressed={state.isBlockquote}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          <Quote className="size-4" />
        </ToolbarButton>
      )}
      {marks.has("link") && (
        <>
          <ToolbarButton
            title={t("toolbar.link")}
            active={hasLink}
            onClick={openLinkPicker}
          >
            <LinkIcon className="size-4" />
          </ToolbarButton>
          <LinkPickerDialog
            open={linkOpen}
            onOpenChange={setLinkOpen}
            initial={linkInitial}
            hasExisting={hasLink}
            onApply={applyLink}
            onRemove={removeLink}
          />
        </>
      )}
      {nodes.has("image") && (
        <>
          <ToolbarButton
            title={t("toolbar.insertImage")}
            onClick={() => setPickerOpen(true)}
          >
            <ImageIcon className="size-4" />
          </ToolbarButton>
          <MediaPicker
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onSelect={(img) => {
              if (img.url) {
                editor
                  .chain()
                  .focus()
                  .setImage({ src: img.url, alt: img.alt })
                  .run()
              }
            }}
          />
        </>
      )}
      {nodes.has("horizontalRule") && (
        <ToolbarButton
          title={t("toolbar.horizontalRule")}
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
        >
          <Minus className="size-4" />
        </ToolbarButton>
      )}
      {nodes.has("table") && (
        <>
          <ToolbarButton
            title={t("toolbar.insertTable")}
            active={state.isInTable}
            onClick={() =>
              editor
                .chain()
                .focus()
                .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
                .run()
            }
          >
            <TableIcon className="size-4" />
          </ToolbarButton>
          {/* Contextual cell controls — only inside a table. */}
          {state.isInTable && (
            <>
              <ToolbarButton
                title={t("toolbar.addRowAbove")}
                onClick={() => editor.chain().focus().addRowBefore().run()}
              >
                <ArrowUpToLine className="size-4" />
              </ToolbarButton>
              <ToolbarButton
                title={t("toolbar.addRowBelow")}
                onClick={() => editor.chain().focus().addRowAfter().run()}
              >
                <ArrowDownToLine className="size-4" />
              </ToolbarButton>
              <ToolbarButton
                title={t("toolbar.deleteRow")}
                onClick={() => editor.chain().focus().deleteRow().run()}
              >
                <Rows3 className="size-4" />
              </ToolbarButton>
              <ToolbarButton
                title={t("toolbar.addColumnLeft")}
                onClick={() => editor.chain().focus().addColumnBefore().run()}
              >
                <ArrowLeftToLine className="size-4" />
              </ToolbarButton>
              <ToolbarButton
                title={t("toolbar.addColumnRight")}
                onClick={() => editor.chain().focus().addColumnAfter().run()}
              >
                <ArrowRightToLine className="size-4" />
              </ToolbarButton>
              <ToolbarButton
                title={t("toolbar.deleteColumn")}
                onClick={() => editor.chain().focus().deleteColumn().run()}
              >
                <Columns3 className="size-4" />
              </ToolbarButton>
              <ToolbarButton
                title={t("toolbar.toggleHeaderRow")}
                onClick={() => editor.chain().focus().toggleHeaderRow().run()}
              >
                <HeadingIcon className="size-4" />
              </ToolbarButton>
              <ToolbarButton
                title={t("toolbar.mergeSplitCells")}
                onClick={() => editor.chain().focus().mergeOrSplit().run()}
              >
                <TableCellsMerge className="size-4" />
              </ToolbarButton>
              <ToolbarButton
                title={t("toolbar.deleteTable")}
                onClick={() => editor.chain().focus().deleteTable().run()}
              >
                <Trash2 className="size-4" />
              </ToolbarButton>
            </>
          )}
        </>
      )}
    </div>
  )
}

/** The editor's extensions: the profile's, narrowed and extended for a title. */
function extensionsFor(profile: RichTextProfile, contract?: FieldContract) {
  const base = extensionsForProfile(profile)
  if (contract !== "title") return base
  const allowed = contractSpec("title").marks
  return [
    ...base.filter(
      (extension) => extension.type !== "mark" || allowed.has(extension.name)
    ),
    TitleInput,
  ]
}

export function RichTextEditor({
  id,
  value,
  onChange,
  profile = "basic",
  contract,
  label,
  sourceValue,
  translate,
  generate,
}: {
  id?: string
  value: string
  /** Receives the document serialized as PM-JSON. */
  onChange: (json: string) => void
  profile?: RichTextProfile
  /** Set for a title field: Enter, paste, marks and the toolbar follow the title contract. */
  contract?: FieldContract
  label?: string
  sourceValue?: string
  translate?: FieldTranslate
  generate?: FieldGenerate
}) {
  const displayError = useCaughtError()
  const t = useTranslations("editor.richText")
  const confirm = useConfirm()
  const promptUser = usePrompt()
  const [slashState, setSlashState] = useState<SlashState | null>(null)
  const [slashActiveIndex, setSlashActiveIndex] = useState(0)
  const [slashRunningId, setSlashRunningId] = useState<string | null>(null)
  // Raw JSON strings this editor emitted, newest last. The effect below reads
  // them to recognise the parent echoing our own output back.
  const emittedRef = useRef<string[]>([])
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      ...extensionsFor(profile, contract),
      ...((contract ?? profile) === "basic" ? [BasicTextPaste] : []),
      UndoRedo,
    ],
    content: toEditorContent(value, profile, contract),
    onUpdate: ({ editor }) => {
      const json = JSON.stringify(editor.getJSON())
      emittedRef.current.push(json)
      if (emittedRef.current.length > 100) emittedRef.current.shift()
      onChange(json)
    },
    editorProps: {
      attributes: {
        ...(id ? { id } : {}),
        ...(label ? { "aria-label": label } : {}),
        "aria-multiline": "true",
        // `prose` styles typography, with the same palette and dark-mode
        // inversion as the other rich-text views (A8: without
        // `dark:prose-invert` the text is grey-700 on the dark background).
        // Tables need an explicit grid because
        // Tailwind typography only draws faint row rules (no cell borders /
        // header fill). These arbitrary utilities are editor-chrome CSS — they
        // style the editing surface, not the stored slice content.
        class:
          "prose prose-sm prose-neutral dark:prose-invert max-w-none min-h-[8rem] px-3 py-2 focus:outline-none " +
          "[&_table]:w-full [&_table]:my-3 [&_table]:border-collapse [&_table]:table-fixed " +
          "[&_.tableWrapper]:overflow-x-auto " +
          "[&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:p-2 [&_th]:text-left [&_th]:font-semibold [&_th]:align-top " +
          "[&_td]:border [&_td]:border-border [&_td]:p-2 [&_td]:align-top [&_td]:min-w-[2rem] " +
          "[&_.selectedCell]:bg-primary/10 [&_.column-resize-handle]:bg-primary [&_.column-resize-handle]:w-[3px]" +
          ((contract ?? profile) === "basic" ? ` ${BASIC_PARAGRAPH_GAP}` : ""),
      },
    },
  })

  const slashCommands: SlashCommand[] = (() => {
    if (!editor || !slashState) return []

    const activeEditor = editor
    const { nodes, headingLevels } = PROFILE_SPECS[profile]
    const marks = contract ? contractSpec(contract).marks : PROFILE_SPECS[profile].marks
    const currentJson = JSON.stringify(activeEditor.getJSON())
    const hasContent = fieldHasContent(currentJson)
    const fieldLabel = label ?? t("richText")

    function replaceContent(next: string) {
      activeEditor.commands.setContent(toEditorContent(next, profile, contract))
    }

    async function writeWithAI() {
      if (!generate) return
      if (hasContent) {
        const ok = await confirm({
          title: t("replace.title", { label: fieldLabel }),
          description: t("replace.writeDescription"),
          confirmText: t("replace.action"),
          destructive: true,
        })
        if (!ok) return
      }
      const brief = await promptUser({
        title: t("write.title", { label: fieldLabel }),
        description: t("write.description"),
        label: t("write.brief"),
        placeholder: t("write.placeholder"),
        confirmText: t("write.action"),
        multiline: true,
        presets: generate.writeBriefs as
          { label: string; body: string }[] | undefined,
        presetsVariant: "dropdown",
        presetsLabel: t("write.presets"),
      })
      if (!brief) return
      replaceContent(await generate.run(brief, fieldLabel, "richText", profile))
    }

    async function refineWithAI(instruction?: string) {
      if (!generate || !hasContent) return
      const promptInstruction =
        instruction ??
        (await promptUser({
          title: t("refine.title", { label: fieldLabel }),
          description: t("refine.description"),
          label: t("refine.instruction"),
          placeholder: t("refine.placeholder"),
          confirmText: t("refine.action"),
          presets: generate.refinePresets as
            { label: string; body: string }[] | undefined,
          presetsVariant: "chips",
          presetsLabel: t("refine.presets"),
        }))
      if (!promptInstruction) return
      replaceContent(
        await generate.runRefine(
          currentJson,
          promptInstruction,
          fieldLabel,
          "richText"
        )
      )
    }

    async function translateField() {
      if (!translate || !sourceValue) return
      if (hasContent) {
        const ok = await confirm({
          title: t("replace.title", { label: fieldLabel }),
          description: t("replace.translationDescription", {
            locale: translate.sourceLocale.toUpperCase(),
          }),
          confirmText: t("replace.action"),
          destructive: true,
        })
        if (!ok) return
      }
      replaceContent(await translate.run(sourceValue, "richText"))
    }

    function fromSlash(
      run: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>
    ) {
      if (!slashState) return
      run(
        activeEditor
          .chain()
          .focus()
          .deleteRange({ from: slashState.from, to: slashState.to })
      ).run()
    }

    async function promptImage() {
      const src = await promptUser({
        title: t("insertImage.title"),
        label: t("insertImage.label"),
        placeholder: t("insertImage.placeholder"),
        confirmText: t("insert"),
      })
      if (!src || !slashState) return
      activeEditor
        .chain()
        .focus()
        .deleteRange({ from: slashState.from, to: slashState.to })
        .setImage({ src })
        .run()
    }

    async function promptLink() {
      const href = await promptUser({
        title: t("insertLink.title"),
        label: t("insertLink.label"),
        placeholder: t("insertLink.placeholder"),
        confirmText: t("insert"),
      })
      if (!href || !slashState) return
      activeEditor
        .chain()
        .focus()
        .deleteRange({ from: slashState.from, to: slashState.to })
        .insertContent({
          type: "text",
          text: href,
          marks: [{ type: "link", attrs: { href } }],
        })
        .run()
    }

    const commands: SlashCommand[] = []

    if (generate) {
      commands.push({
        id: "ai-write",
        label: t("slash.aiWrite.label"),
        description: t("slash.aiWrite.description"),
        icon: PencilLine,
        keywords: ["ai", "write", "assistant", "generate"],
        run: writeWithAI,
      })

      commands.push(
        {
          id: "ai-improve",
          label: t("slash.improve.label"),
          description: t("slash.improve.description"),
          icon: WandSparkles,
          keywords: ["ai", "rewrite", "refine"],
          disabled: !hasContent,
          run: () => refineWithAI("Improve clarity while preserving meaning."),
        },
        {
          id: "ai-shorten",
          label: t("slash.shorten.label"),
          description: t("slash.shorten.description"),
          icon: Wand2,
          keywords: ["ai", "shorten", "concise"],
          disabled: !hasContent,
          run: () => refineWithAI("Make this shorter and more concise."),
        },
        {
          id: "ai-expand",
          label: t("slash.expand.label"),
          description: t("slash.expand.description"),
          icon: Wand2,
          keywords: ["ai", "expand", "longer"],
          disabled: !hasContent,
          run: () => refineWithAI("Expand this with useful detail."),
        },
        {
          id: "ai-tone",
          label: t("slash.tone.label"),
          description: t("slash.tone.description"),
          icon: Wand2,
          keywords: ["ai", "tone", "voice"],
          disabled: !hasContent,
          run: () => refineWithAI(),
        }
      )
    }

    if (translate) {
      commands.push({
        id: "ai-translate",
        label: t("slash.translate.label", {
          locale: translate.sourceLocale.toUpperCase(),
        }),
        description: sourceValue
          ? t("slash.translate.description")
          : t("slash.translate.noSource"),
        icon: Sparkles,
        keywords: ["ai", "translate", "localize"],
        disabled: !sourceValue,
        run: translateField,
      })
    }

    if (nodes.has("paragraph")) {
      commands.push({
        id: "paragraph",
        label: t("slash.paragraph.label"),
        description: t("slash.paragraph.description"),
        icon: Pilcrow,
        run: () => fromSlash((chain) => chain.setParagraph()),
      })
    }

    if (nodes.has("heading")) {
      ;[...headingLevels].forEach((level) => {
        const icons = {
          1: HeadingIcon,
          2: Heading2,
          3: Heading3,
          4: Heading4,
          5: Heading5,
          6: Heading6,
        } as const
        commands.push({
          id: `heading-${level}`,
          label: t("slash.heading.label", { level }),
          description: t("slash.heading.description"),
          icon: icons[level as keyof typeof icons],
          shortcut: modLabel(`Mod-Alt-${level}`),
          keywords: ["title", "header"],
          run: () =>
            fromSlash((chain) =>
              chain.toggleHeading({
                level: level as 1 | 2 | 3 | 4 | 5 | 6,
              })
            ),
        })
      })
    }

    if (nodes.has("bulletList")) {
      commands.push({
        id: "bullet-list",
        label: t("slash.bulletList.label"),
        description: t("slash.bulletList.description"),
        icon: List,
        shortcut: modLabel("Mod-Shift-8"),
        run: () => fromSlash((chain) => chain.toggleBulletList()),
      })
    }

    if (nodes.has("orderedList")) {
      commands.push({
        id: "ordered-list",
        label: t("slash.numberedList.label"),
        description: t("slash.numberedList.description"),
        icon: ListOrdered,
        shortcut: modLabel("Mod-Shift-7"),
        run: () => fromSlash((chain) => chain.toggleOrderedList()),
      })
    }

    if (nodes.has("blockquote")) {
      commands.push({
        id: "blockquote",
        label: t("slash.quote.label"),
        description: t("slash.quote.description"),
        icon: Quote,
        shortcut: modLabel("Mod-Shift-b"),
        run: () => fromSlash((chain) => chain.toggleBlockquote()),
      })
    }

    if (nodes.has("codeBlock")) {
      commands.push({
        id: "code-block",
        label: t("slash.codeBlock.label"),
        description: t("slash.codeBlock.description"),
        icon: Code,
        shortcut: modLabel("Mod-Alt-c"),
        run: () => fromSlash((chain) => chain.toggleCodeBlock()),
      })
    }

    if (nodes.has("horizontalRule")) {
      commands.push({
        id: "divider",
        label: t("slash.divider.label"),
        description: t("slash.divider.description"),
        icon: Minus,
        run: () => fromSlash((chain) => chain.setHorizontalRule()),
      })
    }

    if (nodes.has("table")) {
      commands.push({
        id: "table",
        label: t("slash.table.label"),
        description: t("slash.table.description"),
        icon: TableIcon,
        run: () =>
          fromSlash((chain) =>
            chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          ),
      })
    }

    if (nodes.has("image")) {
      commands.push({
        id: "image",
        label: t("slash.image.label"),
        description: t("slash.image.description"),
        icon: ImageIcon,
        run: promptImage,
      })
    }

    if (marks.has("link")) {
      commands.push({
        id: "link",
        label: t("slash.link.label"),
        description: t("slash.link.description"),
        icon: LinkIcon,
        run: promptLink,
      })
    }

    ;[
      [
        "bold",
        t("toolbar.bold"),
        Bold,
        "Mod-b",
        () => fromSlash((chain) => chain.toggleBold()),
      ],
      [
        "italic",
        t("toolbar.italic"),
        Italic,
        "Mod-i",
        () => fromSlash((chain) => chain.toggleItalic()),
      ],
      [
        "underline",
        t("toolbar.underline"),
        UnderlineIcon,
        "Mod-u",
        () => fromSlash((chain) => chain.toggleUnderline()),
      ],
      [
        "strike",
        t("toolbar.strikethrough"),
        Strikethrough,
        "Mod-Shift-s",
        () => fromSlash((chain) => chain.toggleStrike()),
      ],
      [
        "highlight",
        t("toolbar.highlight"),
        Highlighter,
        "Mod-Shift-h",
        () => fromSlash((chain) => chain.toggleHighlight()),
      ],
      [
        "subscript",
        t("toolbar.subscript"),
        SubscriptIcon,
        "Mod-,",
        () => fromSlash((chain) => chain.toggleSubscript()),
      ],
      [
        "superscript",
        t("toolbar.superscript"),
        SuperscriptIcon,
        "Mod-.",
        () => fromSlash((chain) => chain.toggleSuperscript()),
      ],
      [
        "code",
        t("toolbar.inlineCode"),
        Code,
        "Mod-e",
        () => fromSlash((chain) => chain.toggleCode()),
      ],
    ].forEach(([id, label, icon, shortcut, run]) => {
      if (!marks.has(id as string)) return
      commands.push({
        id: id as string,
        label: label as string,
        description: t("slash.textFormatting"),
        icon: icon as SlashCommand["icon"],
        shortcut: modLabel(shortcut as string),
        run: run as SlashCommand["run"],
      })
    })

    const scored: { command: SlashCommand; score: number }[] = []
    for (const command of commands) {
      const score = slashScore(command, slashState.query)
      if (score > 0) scored.push({ command, score })
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.map(({ command }) => command)
  })()

  useEffect(() => {
    if (!editor) return

    function updateSlashState() {
      setSlashState(detectSlashState(editor!))
    }

    function closeSlashState() {
      setSlashState(null)
    }

    editor.on("transaction", updateSlashState)
    editor.on("selectionUpdate", updateSlashState)
    editor.on("focus", updateSlashState)
    editor.on("blur", closeSlashState)

    return () => {
      editor.off("transaction", updateSlashState)
      editor.off("selectionUpdate", updateSlashState)
      editor.off("focus", updateSlashState)
      editor.off("blur", closeSlashState)
    }
  }, [editor])

  const boundedSlashActiveIndex = Math.min(
    slashActiveIndex,
    Math.max(0, slashCommands.length - 1)
  )

  async function runSlashCommand(command: SlashCommand | undefined) {
    if (!command || command.disabled || slashRunningId) return
    setSlashRunningId(command.id)
    setSlashState(null)
    await Promise.resolve()
      .then(() => command.run())
      .then(
        () => {
          setSlashRunningId(null)
        },
        (err: unknown) => {
          // A refused Save already told the owner why.
          if (!(err instanceof PageSaveRefusedError)) {
            toast.error(displayError(err, t("commandFailed")))
          }
          setSlashRunningId(null)
        }
      )
  }

  function handleSlashKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!slashState) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      setSlashState(null)
      return
    }
    if (slashCommands.length === 0) return
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setSlashActiveIndex((index) =>
        Math.min(slashCommands.length - 1, index + 1)
      )
      return
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setSlashActiveIndex((index) => Math.max(0, index - 1))
      return
    }
    if (event.key === "Enter") {
      event.preventDefault()
      void runSlashCommand(slashCommands[boundedSlashActiveIndex])
    }
  }

  // Sync external `value` changes into a mounted editor. The slice editors reuse
  // the same instance across edits (stable slice id → no remount), so an AI
  // field-level translate that rewrites `value` would otherwise leave the editor
  // showing the pre-translation text.
  //
  // A `value` that arrives here is not always new: React runs this effect after
  // more keystrokes may have landed, so the parent can hand back a document the
  // editor emitted a moment ago while the live doc is already ahead of it.
  // Applying that echo would revert the newer typing and add undo entries. The
  // policy is idempotent under effect replay (StrictMode, dependency changes):
  //   1. `value` equals the live doc (raw, else after the same normalisation
  //      the editor applies to a value): the parent has caught up. Forget the
  //      emissions.
  //   2. `value` equals something this editor emitted (raw, else normalised):
  //      a stale echo of our own typing, possibly coalesced or out of order
  //      before the sync. Do nothing, and keep the emissions; they clear at the
  //      next sync.
  //   3. Otherwise it is a real external change (AI translate, restore, locale
  //      switch): replace the doc without emitting and without an undo entry,
  //      because the owner never typed it.
  // Accepted limits: before the parent catches up, an external value equal to
  // one of the still-unechoed emissions counts as an echo. After it catches up,
  // an older value is a parent write and applies, because the parent is the
  // source of truth (this is what makes Restore of an earlier typed state work).
  useEffect(() => {
    if (!editor) return
    const converted = toEditorContent(value, profile, contract)
    const incoming = JSON.stringify(converted)
    const live = JSON.stringify(editor.getJSON())
    if (
      incoming === live ||
      incoming === JSON.stringify(toEditorContent(live, profile, contract))
    ) {
      emittedRef.current = []
      return
    }
    const isEcho = emittedRef.current.some(
      (raw) =>
        raw === value ||
        JSON.stringify(toEditorContent(raw, profile, contract)) === incoming
    )
    if (isEcho) return
    emittedRef.current = []
    editor
      .chain()
      .setMeta("addToHistory", false)
      .setContent(converted, { emitUpdate: false })
      .run()
  }, [value, editor, profile, contract])

  if (!editor) return null

  return (
    <div
      className="rounded-md border bg-background"
      onKeyDownCapture={handleSlashKeyDown}
    >
      <Toolbar editor={editor} profile={profile} contract={contract} />
      <EditorContent editor={editor} />
      <div className="sr-only" aria-live="polite" aria-atomic={true}>
        {slashState ? slashCommands[boundedSlashActiveIndex]?.label ?? "" : ""}
      </div>
      {slashState && (
        <SlashCommandMenu
          state={slashState}
          commands={slashCommands}
          activeIndex={boundedSlashActiveIndex}
          runningId={slashRunningId}
          onActiveIndexChange={setSlashActiveIndex}
          onRun={(command) => void runSlashCommand(command)}
        />
      )}
    </div>
  )
}
