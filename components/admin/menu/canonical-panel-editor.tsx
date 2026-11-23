"use client"

import { useId } from "react"
import { useConfirm } from "@/components/providers/confirm-provider"
import { useMenuReorder } from "./menu-validation"

import type { LocaleNavItem } from "@/convex/lib/menu"
import {
  generateMenuId,
  isColumnPanel,
  type LocalePanelSection,
} from "@/convex/lib/menu"
import { Button } from "@/components/ui/button"
import { CanonicalSectionEditor } from "./canonical-section-editor"
import { moveItem } from "@/lib/use-drag-reorder"
import { Columns3, Plus } from "lucide-react"
import { useTranslations } from "next-intl"

type LocalePanel = NonNullable<LocaleNavItem["panel"]>

interface CanonicalPanelEditorProps {
  panel: LocalePanel
  locale: string
  onChange: (panel: LocalePanel) => void
  canEditStructure?: boolean
}

function EmptyTarget() {
  return { type: "external" as const, url: "", openInNewTab: true }
}

function newLinkGroup(): Extract<LocalePanelSection, { kind: "linkGroup" }> {
  return { id: generateMenuId(), kind: "linkGroup", links: [] }
}

function newFeatured(): Extract<LocalePanelSection, { kind: "featured" }> {
  return {
    id: generateMenuId(),
    kind: "featured",
    image: { alt: "" },
    heading: "",
    target: EmptyTarget(),
  }
}

function SectionRegionEditor({
  title,
  sections,
  locale,
  onChange,
  canEditStructure,
  columns,
}: {
  title: string
  sections: LocalePanelSection[]
  locale: string
  onChange: (sections: LocalePanelSection[]) => void
  canEditStructure: boolean
  columns: 1 | 2 | 3 | 4
}) {
  const t = useTranslations("menus.panel")
  const tItems = useTranslations("menus.items")
  const confirm = useConfirm()
  const { dragHandlers, handle, feedback } = useMenuReorder(
    (from, to) => onChange(moveItem(sections, from, to)),
    sections.map((section) => section.heading || tItems(`sectionKinds.${section.kind}`))
  )

  return (
    <section className="space-y-3 rounded-md border p-3">
      {canEditStructure && feedback}
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-medium">{title}</h4>
        <span className="text-xs text-muted-foreground">
          {t("sectionCount", { count: sections.length })}
        </span>
      </div>
      {sections.length === 0 && (
        <p className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
          {t("noSections")}
        </p>
      )}
      <div className="space-y-2">
        {sections.map((section, index) => (
          <div
            key={section.id}
            {...(canEditStructure ? dragHandlers(index) : {})}
          >
            <CanonicalSectionEditor
              section={section}
              columns={columns}
              dragHandle={canEditStructure ? handle(index) : undefined}
              locale={locale}
              onChange={(updated) =>
                onChange(
                  sections.map((current) =>
                    current.id === section.id ? updated : current
                  )
                )
              }
              onDelete={async () => {
                if (
                  await confirm({
                    title: tItems("deleteSectionConfirm"),
                    destructive: true,
                  })
                )
                  onChange(sections.filter((current) => current.id !== section.id))
              }}
              onMoveUp={() => onChange(moveItem(sections, index, index - 1))}
              onMoveDown={() => onChange(moveItem(sections, index, index + 1))}
              isFirst={index === 0}
              isLast={index === sections.length - 1}
              canEditStructure={canEditStructure}
            />
          </div>
        ))}
      </div>
      {canEditStructure && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t("addInRegion", {
              action: t("addLinkGroup"),
              region: title,
            })}
            title={t("addInRegion", {
              action: t("addLinkGroup"),
              region: title,
            })}
            onClick={() => onChange([...sections, newLinkGroup()])}
          >
            <Plus className="size-4" />
            {t("addLinkGroup")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t("addInRegion", {
              action: t("addFeaturedSection"),
              region: title,
            })}
            title={t("addInRegion", {
              action: t("addFeaturedSection"),
              region: title,
            })}
            onClick={() => onChange([...sections, newFeatured()])}
          >
            <Plus className="size-4" />
            {t("addFeaturedSection")}
          </Button>
        </div>
      )}
    </section>
  )
}

export function CanonicalPanelEditor({
  panel,
  locale,
  onChange,
  canEditStructure = true,
}: CanonicalPanelEditorProps) {
  const t = useTranslations("menus.panel")
  const columnsId = useId()
  if (isColumnPanel(panel)) return null
  function clamp(sections: LocalePanelSection[], columns: number) {
    return sections.map((section) =>
      section.span && section.span > columns
        ? { ...section, span: columns as 1 | 2 | 3 | 4 }
        : section
    )
  }
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Columns3 className="size-4 text-muted-foreground" />
        <label htmlFor={columnsId} className="text-sm font-medium">
          {t("columns")}
        </label>
        <select
          id={columnsId}
          value={String(panel.columns)}
          onChange={(event) =>
            onChange({
              ...panel,
              columns: Number(event.target.value) as 1 | 2 | 3 | 4,
              sections: clamp(panel.sections, Number(event.target.value)),
              footer: panel.footer
                ? {
                    sections: clamp(
                      panel.footer.sections,
                      Number(event.target.value)
                    ),
                  }
                : undefined,
            })
          }
          disabled={!canEditStructure}
          className="h-9 rounded-md border border-input bg-transparent px-2.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          {[1, 2, 3, 4].map((columns) => (
            <option key={columns} value={columns}>
              {columns}
            </option>
          ))}
        </select>
      </div>

      <SectionRegionEditor
        title={t("panelSections")}
        sections={panel.sections}
        locale={locale}
        onChange={(sections) => onChange({ ...panel, sections })}
        canEditStructure={canEditStructure}
        columns={panel.columns}
      />

      <SectionRegionEditor
        title={t("footerSections")}
        sections={panel.footer?.sections ?? []}
        locale={locale}
        onChange={(sections) =>
          onChange({
            ...panel,
            footer: sections.length > 0 ? { sections } : undefined,
          })
        }
        canEditStructure={canEditStructure}
        columns={panel.columns}
      />
    </div>
  )
}
