"use client"

import { getContentDefault } from "@/lib/i18n/content-defaults"

import { useId, useState, type ReactNode } from "react"
import Image from "next/image"
import { generateMenuId, type LocalePanelSection } from "@/convex/lib/menu"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Toggle } from "@/components/ui/toggle"
import { IconPicker } from "./icon-picker"
import { MediaPicker } from "@/components/admin/media-picker"
import { MenuTargetField } from "./menu-target-field"
import { moveItem } from "@/lib/use-drag-reorder"
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  EyeOff,
  ImageIcon,
  Link as LinkIcon,
  Plus,
  ListFilter,
  Star,
  Trash2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useConfirm } from "@/components/providers/confirm-provider"
import {
  useMenuReorder,
  useErrorExpansion,
  useMenuValidation,
} from "./menu-validation"
import {
  adminContentTypes,
  menuContentTypeOptionLabel,
} from "@/lib/admin/content-types"

type LocaleLink = Extract<LocalePanelSection, { kind: "linkGroup" }>["links"][number]

interface CanonicalSectionEditorProps {
  section: LocalePanelSection
  locale: string
  onChange: (section: LocalePanelSection) => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  isFirst: boolean
  isLast: boolean
  canEditStructure?: boolean
  columns?: 1 | 2 | 3 | 4
  dragHandle?: ReactNode
}

function EmptyTarget() {
  return { type: "external" as const, url: "", openInNewTab: true }
}

function NewLink(): LocaleLink {
  return { id: generateMenuId(), label: "", target: EmptyTarget() }
}

function LinkGroupLinkEditor({
  link,
  locale,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
  canEditStructure,
}: {
  link: LocaleLink
  locale: string
  onChange: (link: LocaleLink) => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  isFirst: boolean
  isLast: boolean
  canEditStructure: boolean
}) {
  const t = useTranslations("menus.items")
  const fieldId = useId()

  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {canEditStructure && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={onMoveUp}
                disabled={isFirst}
                aria-label={t("moveUp")}
              >
                <ArrowUp className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={onMoveDown}
                disabled={isLast}
                aria-label={t("moveDown")}
              >
                <ArrowDown className="size-3.5" />
              </Button>
              <Toggle
                size="sm"
                pressed={link.isDisabled ?? false}
                onPressedChange={(isDisabled) =>
                  onChange({ ...link, isDisabled })
                }
                aria-label={t("disable")}
                title={t("disable")}
              >
                <EyeOff className="size-3.5" />
              </Toggle>
            </>
          )}
        </div>
        {canEditStructure && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-destructive hover:text-destructive"
            onClick={onDelete}
            aria-label={t("delete")}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>

      <div>
        <label htmlFor={`${fieldId}-label`} className="text-sm font-medium">
          {t("buttonLabel")}
        </label>
        <Input
          id={`${fieldId}-label`}
          value={link.label}
          onChange={(event) => onChange({ ...link, label: event.target.value })}
          placeholder={t("buttonLabelPlaceholder")}
        />
      </div>
      <div>
        <label
          htmlFor={`${fieldId}-description`}
          className="text-sm font-medium"
        >
          {t("description")}
        </label>
        <Textarea
          id={`${fieldId}-description`}
          value={link.description ?? ""}
          onChange={(event) =>
            onChange({ ...link, description: event.target.value || undefined })
          }
          placeholder={t("descriptionPlaceholder")}
          rows={2}
        />
      </div>
      {canEditStructure && (
        <div>
          <span className="text-sm font-medium">{t("icon")}</span>
          <div className="mt-1">
            <IconPicker
              value={link.icon}
              onChange={(icon) => onChange({ ...link, icon })}
            />
          </div>
        </div>
      )}
      <MenuTargetField
        validationKey={link.id}
        value={link.target}
        onChange={(target) => target && onChange({ ...link, target })}
        locale={locale}
        canEditTarget={canEditStructure}
        allowEmpty={false}
      />
    </div>
  )
}

export function CanonicalSectionEditor({
  section,
  locale,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
  canEditStructure = true,
  columns = 4,
  dragHandle,
}: CanonicalSectionEditorProps) {
  const t = useTranslations("menus.items")
  const tSection = useTranslations("menus.section")
  const fieldId = useId()
  const imageErrorId = `${fieldId}-image-error`
  const [expanded, setExpanded] = useErrorExpansion(
    (error) => error.sectionId === section.id,
    true
  )
  const confirm = useConfirm()
  const validation = useMenuValidation()
  const [imageBlurred, setImageBlurred] = useState(false)
  const imageError =
    section.kind === "featured" &&
    Boolean(section.image && !section.image?.url) &&
    (validation.attempt > 0 || imageBlurred)
  const [mediaOpen, setMediaOpen] = useState(false)
  const { dragHandlers } = useMenuReorder(
    (from, to) => {
      if (section.kind !== "linkGroup") return
      onChange({ ...section, links: moveItem(section.links, from, to) })
    },
    section.kind === "linkGroup" ? section.links.map((link) => link.label) : []
  )

  function updateLink(id: string, updated: LocaleLink) {
    if (section.kind !== "linkGroup") return
    onChange({
      ...section,
      links: section.links.map((link) => (link.id === id ? updated : link)),
    })
  }

  async function removeLink(id: string) {
    if (
      section.kind !== "linkGroup" ||
      !(await confirm({ title: t("deleteLinkConfirm"), destructive: true }))
    )
      return
    onChange({ ...section, links: section.links.filter((link) => link.id !== id) })
  }

  function moveLink(index: number, direction: -1 | 1) {
    if (section.kind !== "linkGroup") return
    onChange({
      ...section,
      links: moveItem(section.links, index, index + direction),
    })
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center gap-2 px-3 py-2.5">
        {dragHandle}
        {canEditStructure && (
          <div className="flex shrink-0 flex-col">
            <button
              type="button"
              onClick={onMoveUp}
              disabled={isFirst}
              aria-label={t("moveUp")}
              className="text-muted-foreground hover:text-foreground disabled:opacity-30"
            >
              <ArrowUp className="size-3" />
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={isLast}
              aria-label={t("moveDown")}
              className="text-muted-foreground hover:text-foreground disabled:opacity-30"
            >
              <ArrowDown className="size-3" />
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="shrink-0"
          aria-label={expanded ? tSection("collapse") : tSection("expand")}
        >
          {expanded ? (
            <ChevronDown className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 text-muted-foreground" />
          )}
        </button>
        {section.kind === "featured" ? (
          <Star className="size-3.5 shrink-0 text-muted-foreground" />
        ) : section.kind === "dynamicList" ? (
          <ListFilter className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <LinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 text-sm font-medium">
          {section.kind === "featured"
            ? t("sectionKinds.featured")
            : section.kind === "dynamicList"
              ? t("sectionKinds.dynamicList")
              : t("sectionKinds.linkGroup")}
        </span>
        {canEditStructure && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-destructive hover:text-destructive"
            onClick={onDelete}
            aria-label={t("delete")}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>

      {expanded && (
        <div className="space-y-4 border-t p-3">
          {canEditStructure && (
            <div>
              <label
                htmlFor={`${fieldId}-span`}
                className="text-sm font-medium"
              >
                {t("panelSpan")}
              </label>
              <select
                id={`${fieldId}-span`}
                value={String(section.span ?? 1)}
                onChange={(event) =>
                  onChange({
                    ...section,
                    span: Number(event.target.value) as 1 | 2 | 3 | 4,
                  })
                }
                className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm"
              >
                {Array.from({ length: columns }, (_, i) => i + 1).map(
                  (span) => (
                    <option key={span} value={span}>
                      {t("columnCount", { count: span })}
                    </option>
                  )
                )}
              </select>
            </div>
          )}

          {section.kind === "linkGroup" ? (
            <>
              <div>
                <label
                  htmlFor={`${fieldId}-heading`}
                  className="text-sm font-medium"
                >
                  {t("heading")}
                </label>
                <Input
                  id={`${fieldId}-heading`}
                  value={section.heading ?? ""}
                  onChange={(event) =>
                    onChange({
                      ...section,
                      heading: event.target.value || undefined,
                    })
                  }
                  placeholder={t("groupHeadingPlaceholder")}
                />
              </div>
              <div className="space-y-2">
                {section.links.map((link, index) => (
                  <div
                    key={link.id}
                    {...(canEditStructure ? dragHandlers(index) : {})}
                  >
                    <LinkGroupLinkEditor
                      link={link}
                      locale={locale}
                      onChange={(updated) => updateLink(link.id, updated)}
                      onDelete={() => removeLink(link.id)}
                      onMoveUp={() => moveLink(index, -1)}
                      onMoveDown={() => moveLink(index, 1)}
                      isFirst={index === 0}
                      isLast={index === section.links.length - 1}
                      canEditStructure={canEditStructure}
                    />
                  </div>
                ))}
              </div>
              {canEditStructure && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() =>
                    onChange({ ...section, links: [...section.links, NewLink()] })
                  }
                >
                  <Plus className="size-4" />
                  {t("addLink")}
                </Button>
              )}
            </>
          ) : section.kind === "dynamicList" ? (
            <>
              <div>
                <label
                  htmlFor={`${fieldId}-heading`}
                  className="text-sm font-medium"
                >
                  {t("heading")}
                </label>
                <Input
                  id={`${fieldId}-heading`}
                  value={section.heading ?? ""}
                  onChange={(event) =>
                    onChange({
                      ...section,
                      heading: event.target.value || undefined,
                    })
                  }
                  placeholder={t("listHeadingPlaceholder")}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor={`${fieldId}-page-type`}
                    className="text-sm font-medium"
                  >
                    {t("contentType")}
                  </label>
                  <select
                    id={`${fieldId}-page-type`}
                    value={section.source.pageType}
                    onChange={(event) =>
                      onChange({
                        ...section,
                        source: {
                          ...section.source,
                          pageType: event.target
                            .value as typeof section.source.pageType,
                        },
                      })
                    }
                    disabled={!canEditStructure}
                    className="mt-1 flex h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {adminContentTypes().map((contentType) => (
                      <option key={contentType.type} value={contentType.type}>
                        {menuContentTypeOptionLabel(contentType, t)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    htmlFor={`${fieldId}-limit`}
                    className="text-sm font-medium"
                  >
                    {t("itemLimit")}
                  </label>
                  <Input
                    id={`${fieldId}-limit`}
                    type="number"
                    min={1}
                    max={12}
                    step={1}
                    value={section.source.limit}
                    disabled={!canEditStructure}
                    onChange={(event) =>
                      onChange({
                        ...section,
                        source: {
                          ...section.source,
                          limit: Number(event.target.value),
                        },
                      })
                    }
                  />
                </div>
              </div>
              {section.seeAll ? (
                <div className="space-y-3 rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">
                      {t("seeAllLink")}
                    </span>
                    {canEditStructure && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          onChange({ ...section, seeAll: undefined })
                        }
                      >
                        {t("remove")}
                      </Button>
                    )}
                  </div>
                  <div>
                    <label
                      htmlFor={`${fieldId}-see-all-label`}
                      className="text-sm font-medium"
                    >
                      {t("seeAllLabel")}
                    </label>
                    <Input
                      id={`${fieldId}-see-all-label`}
                      value={section.seeAll.label}
                      onChange={(event) =>
                        onChange({
                          ...section,
                          seeAll: {
                            ...section.seeAll!,
                            label: event.target.value,
                          },
                        })
                      }
                    />
                  </div>
                  <MenuTargetField
                    validationKey={`${section.id}-seeAll`}
                    value={section.seeAll.target}
                    onChange={(target) =>
                      target &&
                      onChange({
                        ...section,
                        seeAll: { ...section.seeAll!, target },
                      })
                    }
                    locale={locale}
                    canEditTarget={canEditStructure}
                    allowEmpty={false}
                  />
                </div>
              ) : canEditStructure ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    onChange({
                      ...section,
                      seeAll: {
                        label: getContentDefault(locale, "seeAll"),
                        target: EmptyTarget(),
                      },
                    })
                  }
                >
                  <Plus className="size-4" />
                  {t("addSeeAllLink")}
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <div>
                <label
                  htmlFor={`${fieldId}-heading`}
                  className="text-sm font-medium"
                >
                  {t("heading")}
                </label>
                <Input
                  id={`${fieldId}-heading`}
                  value={section.heading}
                  onChange={(event) =>
                    onChange({ ...section, heading: event.target.value })
                  }
                  placeholder={t("featuredHeadingPlaceholder")}
                />
              </div>
              <div>
                <label
                  htmlFor={`${fieldId}-description`}
                  className="text-sm font-medium"
                >
                  {t("description")}
                </label>
                <Textarea
                  id={`${fieldId}-description`}
                  value={section.description ?? ""}
                  onChange={(event) =>
                    onChange({
                      ...section,
                      description: event.target.value || undefined,
                    })
                  }
                  placeholder={t("descriptionPlaceholder")}
                  rows={2}
                />
              </div>
              {canEditStructure && (
                <div>
                  <span className="text-sm font-medium">
                    {t("image")}{" "}
                    <span className="text-xs text-muted-foreground">
                      {t("required")}
                    </span>
                  </span>
                  <div
                    data-menu-field={`${section.id}-image`}
                    onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget))
                        setImageBlurred(true)
                    }}
                    className="mt-1 flex items-center gap-2"
                  >
                    {section.image?.url ? (
                      <div className="relative size-20 overflow-hidden rounded border">
                        <Image
                          src={section.image?.url}
                          alt={section.image?.alt ?? ""}
                          fill
                          sizes="80px"
                          className="object-cover"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            onChange({
                              ...section,
                              image: { alt: section.image?.alt ?? "" },
                            })
                          }
                          className="absolute top-1 right-1 rounded-full bg-black/50 p-1 text-white hover:bg-black/70"
                          aria-label={t("removeImage")}
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex size-20 items-center justify-center rounded border border-dashed text-muted-foreground">
                        <ImageIcon className="size-6" />
                      </div>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setMediaOpen(true)}
                      aria-invalid={Boolean(imageError)}
                      aria-describedby={imageError ? imageErrorId : undefined}
                      className={imageError ? "border-destructive" : undefined}
                    >
                      {section.image?.url ? t("changeImage") : t("selectImage")}
                    </Button>
                    {imageError && (
                      <p
                        id={imageErrorId}
                        role="alert"
                        className="text-xs text-destructive"
                      >
                        {t("imageRequired")}
                      </p>
                    )}
                    <MediaPicker
                      open={mediaOpen}
                      onOpenChange={setMediaOpen}
                      onSelect={(image) =>
                        onChange({
                          ...section,
                          image: { ...image, alt: section.image?.alt ?? "" },
                        })
                      }
                    />
                  </div>
                </div>
              )}
              <div>
                <label
                  htmlFor={`${fieldId}-alt`}
                  className="text-sm font-medium"
                >
                  {t("imageAlt")}
                </label>
                <Input
                  id={`${fieldId}-alt`}
                  value={section.image?.alt ?? ""}
                  onChange={(event) =>
                    onChange({
                      ...section,
                      image: { ...section.image, alt: event.target.value },
                    })
                  }
                />
              </div>
              <MenuTargetField
                validationKey={section.id}
                value={section.target}
                onChange={(target) => target && onChange({ ...section, target })}
                locale={locale}
                canEditTarget={canEditStructure}
                allowEmpty={false}
              />
            </>
          )}
        </div>
      )}
    </div>
  )
}
