"use client"

import { useRef, useReducer } from "react"
import { useTranslations } from "next-intl"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { FileText, Upload } from "lucide-react"
import {
  markdownToPmJson,
  readFileAsText,
} from "@/lib/import/markdown-to-pmjson"

export type MarkdownImportData = {
  title: string
  /** PM-JSON string for the rich-text-body slice. */
  body: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called when the user confirms the import. */
  onImport: (data: MarkdownImportData) => void
}

type State = {
  markdown: string
  fileName: string
  titleOverride: string
  error: string
  isDragging: boolean
}

type Action =
  | { type: "LOAD_FILE"; text: string; fileName: string; titleOverride: string }
  | { type: "SET_MARKDOWN"; payload: string }
  | { type: "SET_TITLE_OVERRIDE"; payload: string }
  | { type: "SET_ERROR"; payload: string }
  | { type: "SET_DRAGGING"; payload: boolean }
  | { type: "RESET" }

const initialState: State = {
  markdown: "",
  fileName: "",
  titleOverride: "",
  error: "",
  isDragging: false,
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "LOAD_FILE":
      return {
        ...state,
        error: "",
        markdown: action.text,
        fileName: action.fileName,
        titleOverride: action.titleOverride,
      }
    case "SET_MARKDOWN":
      return {
        ...state,
        markdown: action.payload,
        fileName: "",
        titleOverride: "",
      }
    case "SET_TITLE_OVERRIDE":
      return { ...state, titleOverride: action.payload }
    case "SET_ERROR":
      return { ...state, error: action.payload }
    case "SET_DRAGGING":
      return { ...state, isDragging: action.payload }
    case "RESET":
      return initialState
  }
}

export function ImportMarkdownDialog({ open, onOpenChange, onImport }: Props) {
  const displayError = useCaughtError()
  const t = useTranslations("editor.markdownImport")
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [state, dispatch] = useReducer(reducer, initialState)
  const { markdown, fileName, titleOverride, error, isDragging } = state

  function reset() {
    dispatch({ type: "RESET" })
  }

  function close() {
    reset()
    onOpenChange(false)
  }

  async function loadFile(file: File) {
    if (!file.name.endsWith(".md") && !file.name.endsWith(".markdown")) {
      dispatch({
        type: "SET_ERROR",
        payload: t("invalidFile"),
      })
      return
    }
    try {
      const text = await readFileAsText(file)
      const baseName = file.name
        .replace(/\.(md|markdown)$/i, "")
        .replace(/[-_]/g, " ")
      dispatch({
        type: "LOAD_FILE",
        text,
        fileName: file.name,
        titleOverride: baseName,
      })
    } catch {
      dispatch({
        type: "SET_ERROR",
        payload: t("readFailed"),
      })
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) await loadFile(file)
    e.target.value = ""
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    dispatch({ type: "SET_DRAGGING", payload: false })
    const file = e.dataTransfer.files[0]
    if (file) loadFile(file)
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    dispatch({ type: "SET_DRAGGING", payload: true })
  }

  function handleConfirm() {
    if (!markdown.trim()) {
      dispatch({ type: "SET_ERROR", payload: t("noContent") })
      return
    }
    try {
      const fallback =
        titleOverride.trim() ||
        fileName.replace(/\.(md|markdown)$/i, "") ||
        t("importedPage")
      const result = markdownToPmJson(markdown, fallback)
      const title = titleOverride.trim() || result.title || t("importedPage")
      onImport({ title, body: result.body })
      close()
    } catch (err) {
      dispatch({
        type: "SET_ERROR",
        payload:
          displayError(err, t("parseFailed")),
      })
    }
  }

  const lineCount = markdown.trim() ? markdown.trim().split("\n").length : 0
  const wordCount = markdown.trim()
    ? markdown.trim().split(/\s+/).filter(Boolean).length
    : 0

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal={true}
      aria-label={t("title")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <div className="mx-4 w-full max-w-lg overflow-hidden rounded-xl border bg-card shadow-xl">
        <div className="flex items-center gap-2 border-b px-5 py-4">
          <FileText className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("title")}</h2>
        </div>

        <div className="space-y-4 p-5">
          {/* Drop zone / file picker */}
          {/* Drop zone — div instead of button to avoid <input> inside <button> (invalid HTML) */}
          <div
            role="button"
            tabIndex={0}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={() =>
              dispatch({ type: "SET_DRAGGING", payload: false })
            }
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ")
                fileInputRef.current?.click()
            }}
            className={[
              "flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 transition-colors",
              isDragging
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50 hover:bg-accent/30",
            ].join(" ")}
          >
            <Upload className="size-5 text-muted-foreground" />
            <span className="text-center text-sm text-muted-foreground">
              {fileName ? (
                <>
                  <strong className="text-foreground">{fileName}</strong> —{" "}
                  {t("fileSummary", { lineCount, wordCount })}
                </>
              ) : (
                t.rich("dropPrompt", {
                  extension: (chunks) => <strong>{chunks}</strong>,
                })
              )}
            </span>
            <input
              ref={fileInputRef}
              type="file"
              aria-label={t("fileLabel")}
              accept=".md,.markdown"
              className="sr-only"
              onChange={handleFileChange}
            />
          </div>

          {/* Paste fallback */}
          <div className="space-y-1.5">
            <label
              htmlFor="markdown-paste"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("pasteLabel")}
            </label>
            <textarea
              id="markdown-paste"
              value={markdown}
              onChange={(e) =>
                dispatch({ type: "SET_MARKDOWN", payload: e.target.value })
              }
              placeholder={t("pastePlaceholder")}
              rows={6}
              className="w-full resize-none rounded-md border bg-background px-3 py-2 font-mono text-sm focus:ring-1 focus:ring-ring focus:outline-none"
            />
          </div>

          {/* Title override */}
          {markdown.trim() && (
            <div className="space-y-1.5">
              <label
                htmlFor="title-override"
                className="text-xs font-medium text-muted-foreground"
              >
                {t("pageTitle")}
                <span className="ml-1 font-normal">
                  {t("pageTitleHint")}
                </span>
              </label>
              <input
                id="title-override"
                type="text"
                value={titleOverride}
                onChange={(e) =>
                  dispatch({
                    type: "SET_TITLE_OVERRIDE",
                    payload: e.target.value,
                  })
                }
                placeholder={t("titlePlaceholder")}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
              />
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-3 border-t px-5 py-4">
          <button
            type="button"
            onClick={close}
            className="rounded-md border px-4 py-2 text-sm transition-colors hover:bg-accent"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            disabled={!markdown.trim()}
            onClick={handleConfirm}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("action")}
          </button>
        </div>
      </div>
    </div>
  )
}
