"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import { FileDown } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import type { Id } from "@/convex/_generated/dataModel"
import { MediaPicker } from "./media-picker"

/**
 * Tabbed link picker — used by the rich-text editor (and reusable elsewhere) to
 * replace the bare `window.prompt()` flow. Editors pick an internal page (by
 * id, surviving slug renames) or paste a URL, then toggle the shared SEO/trust
 * flags. The dialog never resolves hrefs itself — the public renderer does that
 * via `pagePaths` ctx at render time. We just stash the chosen `pageId` plus a
 * cached `href` for legacy fallback.
 *
 * The body lives in a child component that only mounts while the dialog is
 * open. Form state is therefore `useState(initial)` and resets on every reopen
 * — no useEffect, no stale-state hazards.
 */

export type LinkPickerValue = {
  mode: "page" | "url" | "media"
  pageId: Id<"pages"> | null
  /** External or cached fallback href when mode is page. */
  url: string
  openInNewTab: boolean
  noFollow: boolean
  sponsored: boolean
  ugc: boolean
}

export type LinkPickerResult = {
  /** Display href to write into the mark's `href` attr (fallback for render). */
  href: string
  pageId: Id<"pages"> | null
  openInNewTab: boolean
  noFollow: boolean
  sponsored: boolean
  ugc: boolean
}

const EMPTY: LinkPickerValue = {
  mode: "url",
  pageId: null,
  url: "",
  openInNewTab: false,
  noFollow: false,
  sponsored: false,
  ugc: false,
}

export function LinkPickerDialog({
  open,
  onOpenChange,
  initial,
  hasExisting,
  onApply,
  onRemove,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Current link attrs when editing an existing link; null when adding new. */
  initial: LinkPickerValue | null
  hasExisting: boolean
  onApply: (result: LinkPickerResult) => void
  onRemove: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {open && (
          <PickerBody
            initial={initial ?? EMPTY}
            hasExisting={hasExisting}
            onApply={onApply}
            onRemove={onRemove}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function PickerBody({
  initial,
  hasExisting,
  onApply,
  onRemove,
  onClose,
}: {
  initial: LinkPickerValue
  hasExisting: boolean
  onApply: (result: LinkPickerResult) => void
  onRemove: () => void
  onClose: () => void
}) {
  const t = useTranslations("editor.linkDialog")
  const [state, setState] = useState<LinkPickerValue>(initial)
  const [search, setSearch] = useState("")
  const [mediaOpen, setMediaOpen] = useState(false)
  const pagesList = useQuery(api.cms.pages.listLinkablePages, {
    limit: 50,
  })

  const list = pagesList ?? []
  const q = search.trim().toLowerCase()
  const filteredPages = !q
    ? list.slice(0, 50)
    : list
        .filter((p) => {
          if (p.slug.toLowerCase().includes(q)) return true
          const titles = Object.values(p.localizedTitles)
            .join(" ")
            .toLowerCase()
          return titles.includes(q)
        })
        .slice(0, 50)

  function patch(p: Partial<LinkPickerValue>) {
    setState((s) => ({ ...s, ...p }))
  }

  function handleApply() {
    const result: LinkPickerResult = {
      href: state.url.trim(),
      pageId: state.mode === "page" ? state.pageId : null,
      openInNewTab: state.openInNewTab,
      noFollow: state.noFollow,
      sponsored: state.sponsored,
      ugc: state.ugc,
    }
    if (state.mode === "page" && !result.pageId) return
    if ((state.mode === "url" || state.mode === "media") && !result.href) return
    onApply(result)
  }

  const canApply =
    (state.mode === "page" && !!state.pageId) ||
    ((state.mode === "url" || state.mode === "media") && !!state.url.trim())

  return (
    <>
      <DialogHeader>
        <DialogTitle>{hasExisting ? t("editTitle") : t("addTitle")}</DialogTitle>
      </DialogHeader>

      <div className="flex gap-1 rounded-md border p-1 text-sm">
        <TabButton
          active={state.mode === "page"}
          onClick={() => patch({ mode: "page" })}
        >
          {t("pageTab")}
        </TabButton>
        <TabButton
          active={state.mode === "url"}
          onClick={() => patch({ mode: "url" })}
        >
          {t("urlTab")}
        </TabButton>
        <TabButton
          active={state.mode === "media"}
          onClick={() => patch({ mode: "media", pageId: null })}
        >
          {t("mediaTab")}
        </TabButton>
      </div>

      {state.mode === "page" ? (
        <div className="space-y-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchLabel")}
            className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
          />
          <div className="max-h-64 overflow-y-auto rounded-md border">
            {filteredPages.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                {t("noPages")}
              </p>
            ) : (
              <ul>
                {filteredPages.map((p) => {
                  const title =
                    p.localizedTitles.fr ?? p.localizedTitles.en ?? p.slug
                  const selected = state.pageId === p._id
                  return (
                    <li key={p._id}>
                      <button
                        type="button"
                        onClick={() =>
                          patch({ pageId: p._id, url: `/${p.slug}` })
                        }
                        className={`block w-full px-3 py-2 text-left text-sm hover:bg-accent/50 ${
                          selected ? "bg-accent text-accent-foreground" : ""
                        }`}
                      >
                        <div className="font-medium">{title}</div>
                        <div className="text-xs text-muted-foreground">
                          /{p.slug}
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      ) : state.mode === "url" ? (
        <div>
          <input
            type="text"
            value={state.url}
            onChange={(e) => patch({ url: e.target.value })}
            placeholder={t("urlPlaceholder")}
            aria-label={t("urlLabel")}
            className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
          />
        </div>
      ) : (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setMediaOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-accent/50"
          >
            <FileDown className="size-4" />
            {state.url ? t("changeMedia") : t("chooseMedia")}
          </button>
          {state.url && (
            <p className="truncate text-xs text-muted-foreground">
              {state.url}
            </p>
          )}
          <MediaPicker
            open={mediaOpen}
            onOpenChange={setMediaOpen}
            onSelect={(image) =>
              patch({ mode: "media", pageId: null, url: image.url ?? "" })
            }
          />
        </div>
      )}

      <div className="space-y-2 border-t pt-3 text-sm">
        <Toggle
          label={t("newTab")}
          description={t("newTabDescription")}
          checked={state.openInNewTab}
          onChange={(v) => patch({ openInNewTab: v })}
        />
        <Toggle
          label={t("noFollow")}
          description={t("noFollowDescription")}
          checked={state.noFollow}
          onChange={(v) => patch({ noFollow: v })}
        />
        <Toggle
          label={t("sponsored")}
          description={t("sponsoredDescription")}
          checked={state.sponsored}
          onChange={(v) => patch({ sponsored: v })}
        />
        <Toggle
          label={t("ugc")}
          description={t("ugcDescription")}
          checked={state.ugc}
          onChange={(v) => patch({ ugc: v })}
        />
      </div>

      <DialogFooter>
        {hasExisting && (
          <Button
            type="button"
            variant="ghost"
            onClick={onRemove}
            className="mr-auto text-destructive hover:text-destructive"
          >
            {t("remove")}
          </Button>
        )}
        <Button type="button" variant="outline" onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button type="button" onClick={handleApply} disabled={!canApply}>
          {hasExisting ? t("update") : t("add")}
        </Button>
      </DialogFooter>
    </>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded px-3 py-1.5 transition-colors ${
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50"
      }`}
    >
      {children}
    </button>
  )
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <span>
        <span className="font-medium">{label}</span>
        {description && (
          <span className="block text-xs text-muted-foreground">
            {description}
          </span>
        )}
      </span>
    </label>
  )
}
