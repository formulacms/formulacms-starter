"use client"

import { useId } from "react"
import { useConfirm } from "@/components/providers/confirm-provider"
import { useMenuReorder } from "./menu-validation"

import type { LocaleNavItem } from "@/convex/lib/menu"
import {
  generateMenuId,
  isColumnPanel,
  type LocaleBlock,
} from "@/convex/lib/menu"
import { Button } from "@/components/ui/button"
import { CanonicalBlockEditor } from "./canonical-block-editor"
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

function newLinkGroup(): Extract<LocaleBlock, { kind: "linkGroup" }> {
  return { id: generateMenuId(), kind: "linkGroup", links: [] }
}

function newFeatured(): Extract<LocaleBlock, { kind: "featured" }> {
  return {
    id: generateMenuId(),
    kind: "featured",
    image: { alt: "" },
    heading: "",
    target: EmptyTarget(),
  }
}

function newDynamicList(): Extract<LocaleBlock, { kind: "dynamicList" }> {
  return {
    id: generateMenuId(),
    kind: "dynamicList",
    heading: "",
    source: { pageType: "post", limit: 3 },
  }
}

function BlockRegionEditor({
  title,
  blocks,
  locale,
  onChange,
  canEditStructure,
  columns,
}: {
  title: string
  blocks: LocaleBlock[]
  locale: string
  onChange: (blocks: LocaleBlock[]) => void
  canEditStructure: boolean
  columns: 1 | 2 | 3 | 4
}) {
  const t = useTranslations("menus.panel")
  const tItems = useTranslations("menus.items")
  const confirm = useConfirm()
  const { dragHandlers, handle, feedback } = useMenuReorder(
    (from, to) => onChange(moveItem(blocks, from, to)),
    blocks.map((block) => block.heading || tItems(`blockKinds.${block.kind}`))
  )

  return (
    <section className="space-y-3 rounded-md border p-3">
      {canEditStructure && feedback}
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-medium">{title}</h4>
        <span className="text-xs text-muted-foreground">
          {t("blockCount", { count: blocks.length })}
        </span>
      </div>
      {blocks.length === 0 && (
        <p className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
          {t("noBlocks")}
        </p>
      )}
      <div className="space-y-2">
        {blocks.map((block, index) => (
          <div
            key={block.id}
            {...(canEditStructure ? dragHandlers(index) : {})}
          >
            <CanonicalBlockEditor
              block={block}
              columns={columns}
              dragHandle={canEditStructure ? handle(index) : undefined}
              locale={locale}
              onChange={(updated) =>
                onChange(
                  blocks.map((current) =>
                    current.id === block.id ? updated : current
                  )
                )
              }
              onDelete={async () => {
                if (
                  await confirm({
                    title: tItems("deleteBlockConfirm"),
                    destructive: true,
                  })
                )
                  onChange(blocks.filter((current) => current.id !== block.id))
              }}
              onMoveUp={() => onChange(moveItem(blocks, index, index - 1))}
              onMoveDown={() => onChange(moveItem(blocks, index, index + 1))}
              isFirst={index === 0}
              isLast={index === blocks.length - 1}
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
            onClick={() => onChange([...blocks, newLinkGroup()])}
          >
            <Plus className="size-4" />
            {t("addLinkGroup")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t("addInRegion", {
              action: t("addFeaturedBlock"),
              region: title,
            })}
            title={t("addInRegion", {
              action: t("addFeaturedBlock"),
              region: title,
            })}
            onClick={() => onChange([...blocks, newFeatured()])}
          >
            <Plus className="size-4" />
            {t("addFeaturedBlock")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t("addInRegion", {
              action: t("addDynamicList"),
              region: title,
            })}
            title={t("addInRegion", {
              action: t("addDynamicList"),
              region: title,
            })}
            onClick={() => onChange([...blocks, newDynamicList()])}
          >
            <Plus className="size-4" />
            {t("addDynamicList")}
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
  function clamp(blocks: LocaleBlock[], columns: number) {
    return blocks.map((block) =>
      block.span && block.span > columns
        ? { ...block, span: columns as 1 | 2 | 3 | 4 }
        : block
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
              blocks: clamp(panel.blocks, Number(event.target.value)),
              footer: panel.footer
                ? {
                    blocks: clamp(
                      panel.footer.blocks,
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

      <BlockRegionEditor
        title={t("panelBlocks")}
        blocks={panel.blocks}
        locale={locale}
        onChange={(blocks) => onChange({ ...panel, blocks })}
        canEditStructure={canEditStructure}
        columns={panel.columns}
      />

      <BlockRegionEditor
        title={t("footerBlocks")}
        blocks={panel.footer?.blocks ?? []}
        locale={locale}
        onChange={(blocks) =>
          onChange({
            ...panel,
            footer: blocks.length > 0 ? { blocks } : undefined,
          })
        }
        canEditStructure={canEditStructure}
        columns={panel.columns}
      />
    </div>
  )
}
