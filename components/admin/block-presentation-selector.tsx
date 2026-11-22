"use client"

import { readBlock, hasBlockType } from "@/convex/lib/blocks/identity"

import { useId, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import {
  ArrowLeftRight,
  ArrowRight,
  Check,
  FileText,
  Globe,
  ShieldCheck,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { BlockPresentationPreview } from "./blocks/block-presentation-preview"
import type { Block } from "@/convex/lib/blocks"
import {
  resolveBlockPresentation,
  type BlockPresentationCatalog,
} from "@/convex/lib/blocks/presentationResolution"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export type BlockPresentationContext = {
  pageId?: string
  contentEpoch?: number
  pageTitle?: string
  occurrenceLabel?: string
  locale: string
  otherLocales?: readonly string[]
}

type Props = {
  block: Block
  catalog?: BlockPresentationCatalog
  context?: BlockPresentationContext
  onChange(block: Block): void
}

/** Pending consent belongs to this exact Page/locale/occurrence/catalog. */
export function BlockPresentationSelector(props: Props) {
  return (
    <PresentationChoice
      key={JSON.stringify([
        props.context,
        props.block,
        props.catalog?.revision,
      ])}
      {...props}
    />
  )
}

function PresentationChoice({ block, catalog, context, onChange }: Props) {
  const [pending, setPending] = useState<string | null>(null)
  const displayLocale = useLocale()
  const t = useTranslations("editor.blockEditor.presentation")
  const id = useId()
  if (
    !hasBlockType(block, "hero-with-image") &&
    readBlock(block).presentationIdV1 === undefined
  )
    return null
  const requested = readBlock(block).presentationIdV1 ?? "default"
  const entries =
    catalog?.entries.filter((entry) => entry.type === readBlock(block).type) ??
    []
  const existing = catalog
    ? resolveBlockPresentation(catalog, {
        type: readBlock(block).type,
        presentationId: readBlock(block).presentationIdV1,
        intent: "existing",
      })
    : null
  const current = entries.find((entry) => entry.id === requested)
  const warning = !catalog
    ? "unavailable"
    : existing?.status === "fallback"
      ? "fallback"
      : existing?.status === "refused"
        ? "unavailable"
        : current?.state === "archived"
          ? "archived"
          : null
  const labelFor = (value: string) =>
    value === "default" || value === "centered"
      ? t(value)
      : (entries.find((entry) => entry.id === value)?.label ??
        t("retained", { id: value }))
  const assignable = (value: string) => {
    if (!catalog) return false
    const decision = resolveBlockPresentation(catalog, {
      type: readBlock(block).type,
      presentationId: value,
      intent: "new-assignment",
      expectedCatalogRevision: catalog.revision,
    })
    return decision.status === "resolved" && decision.newAssignable
  }
  const names = new Intl.DisplayNames([displayLocale], { type: "language" })
  const localeName =
    names.of(context?.locale ?? displayLocale) ??
    context?.locale ??
    displayLocale
  const peers = (context?.otherLocales ?? []).map(
    (locale) => names.of(locale) ?? locale
  )
  const peerNames = new Intl.ListFormat(displayLocale, {
    style: "long",
    type: "conjunction",
  }).format(peers)
  if (pending && assignable(pending)) {
    const currentLabel = labelFor(requested)
    const nextLabel = labelFor(pending)
    return (
      <div role="group" aria-label={t("changeTitle")} className="space-y-4">
        <h3 className="flex items-center justify-between gap-2 text-base font-semibold">
          {t("changeTitle")}
          <ArrowLeftRight className="size-4" aria-hidden={true} />
        </h3>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {context?.pageTitle && context.occurrenceLabel && (
            <span className="inline-flex items-center gap-2">
              <FileText className="size-4" aria-hidden={true} />
              {t("occurrenceScope", {
                page: context.pageTitle,
                occurrence: context.occurrenceLabel,
              })}
            </span>
          )}
          <span className="inline-flex items-center gap-2">
            <Globe className="size-4" aria-hidden={true} />
            {t("localeOnly", { locale: localeName })}
          </span>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3">
          <div className="min-w-0">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {t("currentRetained")}
            </p>
            <BlockPresentationPreview
              presentationId={
                existing?.status === "fallback" ? "default" : requested
              }
              label={
                existing?.status === "fallback" ? t("default") : currentLabel
              }
              compact
            />
          </div>
          <ArrowRight
            className="size-4 text-muted-foreground"
            role="img"
            aria-label={t("replaceWith")}
          />
          <div className="min-w-0">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              {t("newActive")}
            </p>
            <BlockPresentationPreview
              presentationId={pending}
              label={nextLabel}
              compact
            />
          </div>
        </div>
        {warning && (
          <p role="status" className="text-xs text-muted-foreground">
            {t(warning)}
          </p>
        )}
        <p className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
          <ShieldCheck className="size-4 shrink-0" aria-hidden={true} />
          <span>
            {peers.length
              ? t("onlyOccurrenceWithPeers", { locales: peerNames })
              : t("onlyOccurrence")}
          </span>
        </p>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPending(null)}
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            aria-label={t("confirmUse", {
              label: nextLabel,
              locale: localeName,
            })}
            onClick={() => {
              if (!assignable(pending)) return
              onChange(Object.assign({}, block, { presentationIdV1: pending }))
              setPending(null)
            }}
          >
            <Check className="size-4" aria-hidden={true} />
            {t("use", { label: nextLabel })}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("afterConfirm")}</p>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium">
        {t("label")}
      </label>
      <Select
        value={requested}
        disabled={!catalog}
        onValueChange={(presentationIdV1) => {
          if (!catalog || presentationIdV1 === requested) return
          const decision = resolveBlockPresentation(catalog, {
            type: readBlock(block).type,
            presentationId: presentationIdV1,
            intent: "new-assignment",
            expectedCatalogRevision: catalog.revision,
          })
          if (decision.status !== "resolved" || !decision.newAssignable) return
          if (hasBlockType(block, "hero-with-image"))
            setPending(presentationIdV1)
          else onChange(Object.assign({}, block, { presentationIdV1 }))
        }}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {!current && (
            <SelectItem value={requested} disabled>
              {t("retained", { id: requested })}
            </SelectItem>
          )}
          {entries.map((entry) => {
            const { label } = entry
            const decision = resolveBlockPresentation(catalog!, {
              type: readBlock(block).type,
              presentationId: entry.id,
              intent: "new-assignment",
              expectedCatalogRevision: catalog!.revision,
            })
            return (
              <SelectItem
                key={entry.id}
                value={entry.id}
                disabled={
                  decision.status !== "resolved" || !decision.newAssignable
                }
              >
                {entry.id === "default" || entry.id === "centered"
                  ? t(entry.id)
                  : label}
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{t("scope")}</p>
      {warning && (
        <p role="status" className="text-xs text-muted-foreground">
          {t(warning)}
        </p>
      )}
    </div>
  )
}
