"use client"

import { getContentDefault } from "@/lib/i18n/content-defaults"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import { FileDown, GripVertical, Plus, Trash2 } from "lucide-react"
import { useDragReorder, moveItem } from "@/lib/use-drag-reorder"
import type { ButtonField, CMSLinkField } from "@/convex/lib/slices"
import type { Id } from "@/convex/_generated/dataModel"
import { ImageFieldEditor } from "./image-field-editor"
import { MediaPicker } from "../media-picker"

const VARIANTS = ["primary", "secondary", "outline", "ghost", "link"] as const
const LINK_TYPES = ["internal", "external", "anchor", "media", "none"] as const

function newButton(locale: string): ButtonField & { itemId: string } {
  return {
    id: crypto.randomUUID(),
    itemId: crypto.randomUUID(),
    label: getContentDefault(locale, "button"),
    link: { type: "none" },
    variant: "primary",
    withIcon: false,
    enabled: true,
  }
}

function createUniqueButtonId(usedIds: Set<string>): string {
  let id = crypto.randomUUID()
  while (usedIds.has(id)) id = crypto.randomUUID()
  return id
}

function normalizeButtonIds(buttons: ButtonField[]): ButtonField[] {
  const usedIds = new Set<string>()
  let changed = false
  const normalized = buttons.map((button) => {
    if (button.id && !usedIds.has(button.id)) {
      usedIds.add(button.id)
      return button
    }

    changed = true
    const id = createUniqueButtonId(usedIds)
    usedIds.add(id)
    return { ...button, id }
  })
  return changed ? normalized : buttons
}

function buttonRenderKeys(buttons: ButtonField[], basePath: string): string[] {
  const idCounts = new Map<string, number>()
  for (const button of buttons) {
    if (button.id) idCounts.set(button.id, (idCounts.get(button.id) ?? 0) + 1)
  }

  return buttons.map((button, index) => {
    if (!button.id) return `missing:${basePath}:${index}`
    if (idCounts.get(button.id) === 1) return `id:${button.id}`
    return `duplicate:${button.id}:${index}`
  })
}

export function ButtonsEditor({
  value,
  onChange,
  basePath = "items",
  locale = "en",
}: {
  value: ButtonField[]
  onChange: (next: ButtonField[]) => void
  basePath?: string
  locale?: string
}) {
  const t = useTranslations("editor.buttons")
  const buttons = value
  const renderKeys = buttonRenderKeys(buttons, basePath)
  const [mediaPickerIndex, setMediaPickerIndex] = useState<number | null>(null)
  const pages =
    useQuery(api.cms.pages.listLinkablePages, {
      limit: 100,
    }) ?? []
  const { dragHandlers } = useDragReorder((from, to) =>
    onChange(moveItem(normalizeButtonIds(buttons), from, to))
  )

  function update(index: number, patch: Partial<ButtonField>) {
    const normalized = normalizeButtonIds(buttons)
    onChange(
      normalized.map((button, i) =>
        i === index ? { ...button, ...patch } : button
      )
    )
  }

  function updateLink(index: number, patch: Partial<CMSLinkField>) {
    const link = { ...buttons[index].link, ...patch }
    update(index, { link })
  }

  function addButton() {
    onChange(normalizeButtonIds([...buttons, newButton(locale)]))
  }

  function removeButton(index: number) {
    onChange(normalizeButtonIds(buttons.filter((_, idx) => idx !== index)))
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="block text-sm font-medium">{t("title")}</span>
        <button
          type="button"
          onClick={addButton}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
        >
          <Plus className="size-3.5" />
          {t("add")}
        </button>
      </div>

      {buttons.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      )}

      <div className="space-y-2">
        {buttons.map((button, i) => (
          <div
            key={renderKeys[i]}
            {...dragHandlers(i)}
            className="space-y-2 rounded-md border bg-card p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" />
              <input
                type="text"
                value={button.label}
                onChange={(e) => update(i, { label: e.target.value })}
                placeholder={t("labelPlaceholder")}
                aria-label={t("label")}
                data-slice-field-path={`${basePath}.${i}.label`}
                className="min-w-[120px] flex-1 rounded border bg-background px-2 py-1 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
              />
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <select
                  value={button.variant ?? "primary"}
                  aria-label={t("variant", { index: i + 1 })}
                  onChange={(e) =>
                    update(i, {
                      variant: e.target.value as ButtonField["variant"],
                    })
                  }
                  className="rounded border bg-background px-2 py-1 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
                >
                  {VARIANTS.map((v) => (
                    <option key={v} value={v}>
                      {t(`variants.${v}`)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => removeButton(i)}
                  title={t("remove")}
                  className="rounded p-1 text-muted-foreground transition-colors hover:text-destructive"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 pl-6">
              <select
                value={button.link.type}
                aria-label={t("linkType", { index: i + 1 })}
                onChange={(e) =>
                  updateLink(i, {
                    type: e.target.value as CMSLinkField["type"],
                  })
                }
                className="rounded border bg-background px-2 py-1 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
              >
                {LINK_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`linkTypes.${type}`)}
                  </option>
                ))}
              </select>

              {button.link.type === "internal" && (
                <select
                  value={button.link.pageId ?? ""}
                  aria-label={t("internalPage", { index: i + 1 })}
                  onChange={(e) =>
                    updateLink(i, {
                      pageId: (e.target.value || undefined) as
                        Id<"pages"> | undefined,
                    })
                  }
                  className="min-w-0 flex-[1_1_160px] rounded border bg-background px-2 py-1 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
                >
                  <option value="">{t("selectPage")}</option>
                  {pages.map((p) => (
                    <option key={p._id} value={p._id}>
                      /{p.slug}
                    </option>
                  ))}
                </select>
              )}

              {button.link.type === "external" && (
                <input
                  type="text"
                  value={button.link.url ?? ""}
                  onChange={(e) => updateLink(i, { url: e.target.value })}
                  placeholder={t("externalPlaceholder")}
                  aria-label={t("externalUrl")}
                  className="min-w-0 flex-[1_1_160px] rounded border bg-background px-2 py-1 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
                />
              )}

              {button.link.type === "anchor" && (
                <input
                  type="text"
                  value={button.link.anchor ?? ""}
                  onChange={(e) => updateLink(i, { anchor: e.target.value })}
                  placeholder={t("anchorPlaceholder")}
                  aria-label={t("anchorTarget")}
                  className="min-w-0 flex-[1_1_160px] rounded border bg-background px-2 py-1 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
                />
              )}

              {button.link.type === "media" && (
                <div className="flex flex-1 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setMediaPickerIndex(i)}
                    className="inline-flex items-center gap-1.5 rounded border bg-background px-2 py-1 text-sm hover:bg-accent/50"
                  >
                    <FileDown className="size-3.5" />
                    {button.link.url ? t("changeMedia") : t("chooseMedia")}
                  </button>
                  {button.link.url && (
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {button.link.url}
                    </span>
                  )}
                </div>
              )}
            </div>

            {(button.link.type === "external" ||
              button.link.type === "internal") && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6">
                <label className="flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={button.link.openInNewTab ?? false}
                    onChange={(e) =>
                      updateLink(i, { openInNewTab: e.target.checked })
                    }
                  />
                  {t("newTab")}
                </label>
                <label className="flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={button.link.noFollow ?? false}
                    onChange={(e) =>
                      updateLink(i, { noFollow: e.target.checked || undefined })
                    }
                  />
                  {t("noFollow")}
                </label>
                <label className="flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={button.link.sponsored ?? false}
                    onChange={(e) =>
                      updateLink(i, {
                        sponsored: e.target.checked || undefined,
                      })
                    }
                  />
                  {t("sponsored")}
                </label>
                <label className="flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={button.link.ugc ?? false}
                    onChange={(e) =>
                      updateLink(i, { ugc: e.target.checked || undefined })
                    }
                  />
                  {t("ugc")}
                </label>
              </div>
            )}

            <div className="space-y-2 pl-6">
              <label className="flex items-center gap-2 text-xs whitespace-nowrap text-muted-foreground">
                <input
                  type="checkbox"
                  checked={button.withIcon ?? false}
                  onChange={(e) =>
                    update(i, {
                      withIcon: e.target.checked,
                      ...(!e.target.checked && { icon: undefined }),
                    })
                  }
                />
                {t("showIcon")}
              </label>
              {button.withIcon === true && (
                <div data-slice-field-path={`${basePath}.${i}.icon`}>
                  <ImageFieldEditor
                    label={t("icon")}
                    value={button.icon}
                    onChange={(icon) => update(i, { icon })}
                  />
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <MediaPicker
        open={mediaPickerIndex !== null}
        onOpenChange={(open) => {
          if (!open) setMediaPickerIndex(null)
        }}
        onSelect={(image, media) => {
          if (mediaPickerIndex === null) return
          updateLink(mediaPickerIndex, {
            type: "media",
            mediaId: media._id,
            storageId: image.storageId,
            url: image.url,
          })
        }}
      />
    </div>
  )
}
