"use client"
import Link from "next/link"
import { Loader2, Redo2, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { TWEAK_SCOPE_LABELS } from "@/lib/slices/visual-tweak/spacing-operation"
import { TYPOGRAPHY_ROLES } from "@/lib/slices/visual-tweak/capabilities"
import {
  typographyTokenName,
  type TypographyPreviewEdits,
  type TypographyProperty,
} from "@/lib/slices/visual-tweak/typography"
import { useVisualTweak } from "./visual-tweak-store"

const typographyProperties: TypographyProperty[] = [
  "font-size",
  "line-height",
  "letter-spacing",
]

function typographyReviewRows(edits: TypographyPreviewEdits = {}) {
  return TYPOGRAPHY_ROLES.flatMap((role) =>
    typographyProperties.flatMap((property) => {
      const edit = edits[role]?.[property]
      return edit
        ? [{ token: typographyTokenName(role, property), ...edit }]
        : []
    })
  )
}

function TypographyReview({
  rows,
}: {
  rows: ReturnType<typeof typographyReviewRows>
}) {
  if (!rows.length) return null
  return (
    <section aria-label="Typography" className="space-y-2 text-xs">
      <h4 className="font-medium text-foreground">Typography</h4>
      <ul
        aria-label="Typography review rows"
        className="max-h-64 space-y-2 overflow-y-auto"
      >
        {rows.map((row) => (
          <li key={row.token} className="flex flex-col gap-1">
            <code className="break-all">{row.token}</code>
            <code className="break-all text-muted-foreground">
              {row.before} → {row.after}
            </code>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">Preview only · Site-wide tokens</p>
      <Link
        href="/admin/design-system"
        className="text-foreground underline underline-offset-4"
      >
        Design system
      </Link>
    </section>
  )
}

export function VisualTweakSaveBar({ compact = false }: { compact?: boolean }) {
  const {
    editCount,
    saving,
    blockedReason,
    status,
    failures,
    save,
    discard,
    undo,
    redo,
    canUndo,
    canRedo,
    savedCheckpoint,
    undoSaved,
    pendingRows,
    typography,
  } = useVisualTweak()
  const dirty = editCount > 0
  const typographyRows = typographyReviewRows(typography)
  const hasDraft = dirty || typographyRows.length > 0
  if (compact)
    return (
      <div className="flex items-center gap-1" aria-label="Appearance actions">
        <Button
          variant="ghost"
          size="icon-sm"
          className="[@media(max-width:760px)]:size-7"
          aria-label="Undo"
          title="Undo (⌘Z)"
          disabled={saving || !canUndo}
          onClick={undo}
        >
          <Undo2 />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="[@media(max-width:760px)]:size-7"
          aria-label="Redo"
          title="Redo (⇧⌘Z)"
          disabled={saving || !canRedo}
          onClick={redo}
        >
          <Redo2 />
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              size="sm"
              className="[@media(max-width:760px)]:h-7"
              aria-label="Review appearance changes"
              title="Save appearance — applies to every Page using this Block"
              disabled={saving || (!hasDraft && !savedCheckpoint)}
            >
              {dirty ? "Save" : "Review"}
              {dirty && (
                <span className="rounded bg-background/20 px-1 text-xs">
                  {editCount}
                </span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="w-80 max-w-[calc(100vw-2rem)]"
            aria-label="Appearance review"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <div className="flex flex-col gap-3">
              <div>
                <h3 className="text-sm font-medium">Appearance changes</h3>
                <p className="text-xs text-muted-foreground">
                  Applies to every Page using this Block.
                </p>
              </div>
              <ul
                aria-label="Appearance review rows"
                className="flex max-h-64 flex-col gap-2 overflow-y-auto text-xs"
              >
                {pendingRows.map((row) => (
                  <li key={row.id} className="flex flex-col gap-1">
                    <span>
                      {row.label} · {row.group.replace("spacing:", "")} ·{" "}
                      {TWEAK_SCOPE_LABELS[row.scope]}
                    </span>
                    <code className="break-all text-muted-foreground">
                      {row.before || "(no class)"} → {row.after || "(no class)"}
                    </code>
                  </li>
                ))}
              </ul>
              <TypographyReview rows={typographyRows} />
              {blockedReason && (
                <p role="alert" className="text-xs text-destructive">
                  {blockedReason}
                </p>
              )}
              {failures.map((failure) => (
                <p
                  key={`${failure.scope}:${failure.path}:${failure.axis}`}
                  className="text-xs text-destructive"
                >
                  {failure.axis}: {failure.reason}
                </p>
              ))}
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={saving || !hasDraft}
                  onClick={discard}
                >
                  Discard
                </Button>
                {(dirty || !typographyRows.length) && (
                  <Button
                    size="sm"
                    aria-label="Save appearance changes"
                    disabled={saving || !dirty || !!blockedReason}
                    onClick={save}
                  >
                    {saving && <Loader2 className="animate-spin" />}Save
                  </Button>
                )}
              </div>
              {savedCheckpoint && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={saving}
                  onClick={undoSaved}
                >
                  Undo saved appearance changes
                </Button>
              )}
            </div>
          </PopoverContent>
        </Popover>
        {status && (
          <span
            role="status"
            className={
              status.kind === "error"
                ? "max-w-48 truncate text-xs text-destructive"
                : "sr-only"
            }
          >
            {status.message}
          </span>
        )}
      </div>
    )
  // Stay mounted while redo is still possible (undo emptied the batch) so the
  // redo button remains reachable, not just its Cmd+Shift+Z shortcut.
  if (!hasDraft && !status && !canUndo && !canRedo && !savedCheckpoint)
    return null

  return (
    // Sticky + z-lifted so it stays reachable above the inspector popover
    // (Radix content is z-50), which is anchored at the bottom of the slice and
    // would otherwise occlude Save/Discard. Owner ruling: fix the occlusion by
    // raising the bar, never by floating the popover over the render.
    <div className="sticky bottom-4 z-[60] flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-background px-4 py-2.5 shadow-lg">
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 items-center gap-3">
          {dirty ? (
            <span className="text-sm font-medium text-foreground">
              {editCount} unsaved appearance change{editCount === 1 ? "" : "s"}
            </span>
          ) : null}
          {status ? (
            <span
              className={cn(
                "truncate text-xs",
                status.kind === "error"
                  ? "text-destructive"
                  : "text-muted-foreground"
              )}
            >
              {status.message}
            </span>
          ) : null}
        </div>
        {failures.length > 0 ? (
          <ul className="space-y-0.5 text-xs text-destructive">
            {failures.map((failure) => (
              <li key={`${failure.scope}:${failure.path}:${failure.axis}`}>
                {failure.axis} on {failure.path || "the whole block"}:{" "}
                {failure.reason}
              </li>
            ))}
          </ul>
        ) : null}
        {pendingRows.length > 0 ? (
          <ul className="max-h-32 space-y-1 overflow-y-auto text-xs text-muted-foreground">
            {pendingRows.map((row) => (
              <li key={row.id}>
                <span className="font-medium text-foreground">{row.label}</span>
                {" · "}
                {TWEAK_SCOPE_LABELS[row.scope]}
                {row.templateWide ? " · all repeated instances" : ""}
                <span className="block truncate font-mono">
                  {row.before || "(no class)"} → {row.after}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <TypographyReview rows={typographyRows} />
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={saving || !canUndo}
          onClick={undo}
          aria-label="Undo (⌘Z)"
          title="Undo (⌘Z)"
        >
          <Undo2 className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={saving || !canRedo}
          onClick={redo}
          aria-label="Redo (⇧⌘Z)"
          title="Redo (⇧⌘Z)"
        >
          <Redo2 className="size-3.5" />
        </Button>
        {hasDraft ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={discard}
            >
              Discard
            </Button>
            {dirty && (
              <Button
                type="button"
                size="sm"
                disabled={saving || !!blockedReason}
                onClick={save}
              >
                {saving ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    Saving appearance…
                  </>
                ) : (
                  "Save appearance changes"
                )}
              </Button>
            )}
          </>
        ) : null}
        {savedCheckpoint ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={undoSaved}
          >
            Undo saved appearance changes
          </Button>
        ) : null}
      </div>
    </div>
  )
}
