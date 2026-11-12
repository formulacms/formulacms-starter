"use client"

import type { ReactNode } from "react"
import { useConfirm } from "@/components/providers/confirm-provider"
import { useErrorExpansion } from "./menu-validation"
import { Badge } from "@/components/ui/badge"
import type { LocaleNavItem } from "@/convex/lib/menu"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Toggle } from "@/components/ui/toggle"
import { CanonicalPanelEditor } from "./canonical-panel-editor"
import { MenuTargetField } from "./menu-target-field"
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  EyeOff,
  LayoutGrid,
  Trash2,
} from "lucide-react"
import { useTranslations } from "next-intl"

interface CanonicalNavItemEditorProps {
  item: LocaleNavItem
  locale: string
  onChange: (item: LocaleNavItem) => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  isFirst: boolean
  isLast: boolean
  canEditStructure?: boolean
  dragHandle?: ReactNode
}

export function CanonicalNavItemEditor({
  item,
  locale,
  onChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
  canEditStructure = true,
  dragHandle,
}: CanonicalNavItemEditorProps) {
  const t = useTranslations("menus.navigationItem")
  const [expanded, setExpanded] = useErrorExpansion(
    (error) => error.itemId === item.id
  )
  const confirm = useConfirm()

  return (
    <div
      className={`overflow-hidden rounded-lg border bg-card ${item.isDisabled ? "opacity-50" : ""}`}
    >
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
              <ArrowUp className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={isLast}
              aria-label={t("moveDown")}
              className="text-muted-foreground hover:text-foreground disabled:opacity-30"
            >
              <ArrowDown className="size-3.5" />
            </button>
          </div>
        )}
        <Input
          value={item.label}
          onChange={(event) => onChange({ ...item, label: event.target.value })}
          placeholder={t("labelPlaceholder")}
          className="h-8 flex-1 font-medium"
          aria-label={t("labelPlaceholder")}
        />
        {item.isDisabled && <Badge variant="secondary">{t("disabled")}</Badge>}
        {item.panel && (
          <LayoutGrid className="size-4 shrink-0 text-muted-foreground" />
        )}
        {canEditStructure && (
          <Toggle
            size="sm"
            pressed={item.isDisabled ?? false}
            onPressedChange={(isDisabled) => onChange({ ...item, isDisabled })}
            aria-label={t("disable")}
            title={t("disable")}
          >
            <EyeOff className="size-4" />
          </Toggle>
        )}
        {canEditStructure && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 text-destructive hover:text-destructive"
            onClick={onDelete}
            aria-label={t("delete")}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() => setExpanded((current) => !current)}
          aria-label={expanded ? t("collapse") : t("expand")}
        >
          {expanded ? (
            <ChevronUp className="size-4" />
          ) : (
            <ChevronDown className="size-4" />
          )}
        </Button>
      </div>

      {expanded && (
        <div className="space-y-5 border-t p-3">
          <MenuTargetField
            value={item.target}
            validationKey={item.id}
            onChange={(target) =>
              onChange({ ...item, target, panel: undefined })
            }
            locale={locale}
            canEditTarget={canEditStructure}
            panelSelected={Boolean(item.panel)}
            onSelectPanel={
              canEditStructure
                ? () =>
                    onChange({
                      ...item,
                      panel: item.panel ?? { columns: 1, blocks: [] },
                    })
                : undefined
            }
            confirmLeavePanel={(type) =>
              confirm({
                title: t("leavePanelConfirm", { type }),
                destructive: true,
              })
            }
            panelContent={
              item.panel && (
                <>
                  <div className="space-y-1">
                    <h4 className="text-sm font-medium">{t("simpleLink")}</h4>
                    <p className="text-sm text-muted-foreground">
                      {t("panelLinkHint")}
                    </p>
                    <MenuTargetField
                      value={item.target}
                      validationKey={item.id}
                      onChange={(target) => onChange({ ...item, target })}
                      locale={locale}
                      canEditTarget={canEditStructure}
                    />
                  </div>
                  <div className="mt-5 flex items-center justify-between gap-3">
                    <h4 className="text-sm font-medium">{t("panelMenu")}</h4>
                    {canEditStructure && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={async () => {
                          if (
                            await confirm({
                              title: t("removePanelConfirm"),
                              destructive: true,
                            })
                          )
                            onChange({ ...item, panel: undefined })
                        }}
                      >
                        {t("removePanel")}
                      </Button>
                    )}
                  </div>
                  <CanonicalPanelEditor
                    panel={item.panel}
                    locale={locale}
                    onChange={(panel) => onChange({ ...item, panel })}
                    canEditStructure={canEditStructure}
                  />
                </>
              )
            }
          />
        </div>
      )}
    </div>
  )
}
