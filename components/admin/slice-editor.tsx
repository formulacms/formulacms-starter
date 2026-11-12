"use client"

import { readSliceDefinition } from "@/convex/lib/slices"
import { readSlice, sliceTypeOf } from "@/convex/lib/slices/identity"

import { adminSliceMetadata } from "@/lib/i18n/admin-metadata"

import { useState } from "react"
import { validate } from "convex-helpers/validators"
import { button, list } from "@/convex/lib/slices"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  Copy,
  Loader2,
  Sparkles,
  PencilLine,
  AlertTriangle,
} from "lucide-react"
import { type Slice, type Primitive } from "@/convex/lib/slices"
import {
  GroupFields,
  ListItemsEditor,
  type FieldTranslate,
  type FieldGenerate,
} from "./fields/field-editor"
import { ButtonsEditor } from "./fields/buttons-editor"
import { useConfirm, usePrompt } from "@/components/providers/confirm-provider"
import { mergeSliceText, sliceHasContent } from "./slice-editor-text"
import { PageSaveRefusedError } from "@/components/admin/page-editor/lib/page-save-refused-error"
import type { SlicePresentationCatalog } from "@/convex/lib/slices/presentationResolution"
import {
  SlicePresentationSelector,
  type SlicePresentationContext,
} from "./slice-presentation-selector"

const buttonItemsValidator = list(button).validator

function isButtonList(def: Primitive): boolean {
  if (def.kind !== "list") return false
  const item = def.config.item as Primitive | undefined
  if (item?.kind !== "group") return false
  const fields = item.config.fields as Record<string, Primitive> | undefined
  return (
    fields?.label?.kind === "text" &&
    fields.link?.kind === "link" &&
    fields.variant?.kind === "select"
  )
}

/**
 * Shown when a stored slice's `type` is absent from the registry (a retired or
 * renamed slice type). Mirrors the public {@link FallbackSlice}: the page never
 * breaks, and the builder's remove control lets the editor delete the orphan.
 */
function UnknownSliceNotice({ type }: { type: string }) {
  const t = useTranslations("editor.sliceEditor")
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed border-destructive/40 bg-destructive/5 p-3 text-sm">
      <AlertTriangle className="size-4 shrink-0 text-destructive" />
      <div className="space-y-1">
        <p className="font-medium">{t("unknown.title")}</p>
        <p className="text-muted-foreground">
          {t.rich("unknown.description", {
            type: () => <code className="font-mono text-xs">{type}</code>,
          })}
        </p>
      </div>
    </div>
  )
}

/**
 * Generic, schema-driven slice editor (ADR-0008, Phase C). Walks the slice's
 * `primary` group from the registry instead of hand-coding a form per type;
 * button `items` still use the bespoke {@link ButtonsEditor}, while other
 * bounded item lists use the generic group-list editor.
 *
 * `sourceSlice` is the same-position, same-type slice from the translation
 * source locale (resolved in slice-builder); it feeds per-field translation
 * pulls and the slice-level toolbar. It is undefined when no source locale has
 * content or the structures have diverged, which disables those affordances.
 */
export function SliceEditor({
  slice,
  onChange,
  locale,
  sourceSlice,
  translate,
  generate,
  presentationCatalog,
  presentationContext,
}: {
  slice: Slice
  onChange: (slice: Slice) => void
  locale: string
  sourceSlice?: Slice
  translate?: FieldTranslate
  generate?: FieldGenerate
  presentationCatalog?: SlicePresentationCatalog
  presentationContext?: SlicePresentationContext
}) {
  const t = useTranslations("editor.sliceEditor")
  const def = readSliceDefinition(readSlice(slice).type)
  // The stored page may carry a slice whose type is no longer registered (a
  // retired/renamed slice type). Degrade gracefully like the public-side
  // FallbackSlice instead of crashing the whole page editor — the builder's
  // remove button stays available so the editor can delete the orphan.
  if (!def) return <UnknownSliceNotice type={readSlice(slice).type} />
  const itemsDef = def.items
  const hasItems = itemsDef !== undefined
  const hasButtonItems = hasItems && isButtonList(itemsDef)
  const buttonItems: unknown = "items" in slice ? readSlice(slice).items : []
  const validButtonItems = validate(buttonItemsValidator, buttonItems)
  if (hasButtonItems && !validButtonItems)
    throw new Error("Invalid button items.")
  return (
    <div className="space-y-4">
      <SlicePresentationSelector
        slice={slice}
        catalog={presentationCatalog}
        context={presentationContext}
        onChange={onChange}
      />
      {(translate || generate) && (
        <SliceToolbar
          slice={slice}
          onChange={onChange}
          sourceSlice={sourceSlice}
          translate={translate}
          generate={generate}
          primaryDef={def.primary}
        />
      )}
      <GroupFields
        def={def.primary}
        value={readSlice(slice).primary}
        onChange={(primary) =>
          onChange(Object.assign({}, slice, { primary }) as Slice)
        }
        locale={locale}
        sourcePrimary={
          readSlice(sourceSlice)?.primary as Record<string, unknown> | undefined
        }
        translate={translate}
        generate={generate}
        sliceType={readSlice(slice).type}
      />
      {hasButtonItems && (
        <ButtonsEditor
          locale={locale}
          value={validButtonItems ? buttonItems : []}
          onChange={(items) => onChange(Object.assign({}, slice, { items }))}
          basePath="items"
        />
      )}
      {hasItems && !hasButtonItems && (
        <ListItemsEditor
          label={t("items")}
          def={itemsDef}
          value={(slice as { items?: unknown[] }).items ?? []}
          onChange={(items) => onChange(Object.assign({}, slice, { items }))}
          basePath="items"
          locale={locale}
          sourceValue={
            (sourceSlice as { items?: unknown[] } | undefined)?.items
          }
          translate={translate}
          generate={generate}
          sliceType={readSlice(slice).type}
        />
      )}
    </div>
  )
}

/**
 * Whole-slice actions row. Renders only the actions wired by the host:
 * Write with AI (when `generate` is set), Copy / Translate from another locale
 * (when `translate` is set). All actions act on every text field of the slice
 * at once, leaving image / layout / selects / link hrefs untouched.
 *
 * Bundled into one row so a bilingual page with AI configured doesn't show
 * two stacked "Whole slice" toolbars.
 */
function SliceToolbar({
  slice,
  onChange,
  sourceSlice,
  translate,
  generate,
  primaryDef,
}: {
  slice: Slice
  onChange: (slice: Slice) => void
  sourceSlice?: Slice
  translate?: FieldTranslate
  generate?: FieldGenerate
  primaryDef: Primitive
}) {
  const t = useTranslations("editor.sliceEditor")
  const tMetadata = useTranslations("metadata")
  const confirm = useConfirm()
  const promptUser = usePrompt()
  const [busy, setBusy] = useState(false)
  const loc = translate?.sourceLocale.toUpperCase()
  const hasSource = !!sourceSlice
  const sliceLabel =
    adminSliceMetadata(readSlice(slice).type, tMetadata)?.label ??
    readSlice(slice).type

  async function confirmOverwrite(
    action: "copy" | "translate" | "write"
  ): Promise<boolean> {
    if (!sliceHasContent(slice, primaryDef)) return true
    const description =
      action === "copy"
        ? t("overwrite.copy", { locale: loc ?? "" })
        : action === "translate"
          ? t("overwrite.translate", { locale: loc ?? "" })
          : t("overwrite.write")
    return confirm({
      title: t("overwrite.title", { label: sliceLabel }),
      description,
      confirmText: t("overwrite.action"),
      destructive: true,
    })
  }

  async function copy() {
    if (!translate || !sourceSlice) return
    if (!(await confirmOverwrite("copy"))) return
    onChange(mergeSliceText(slice, sourceSlice, primaryDef, "copy"))
  }

  async function translateSlice() {
    if (!translate?.runSlice || !sourceSlice) return
    if (!(await confirmOverwrite("translate"))) return
    setBusy(true)
    try {
      const translated = await translate.runSlice(sourceSlice)
      onChange(mergeSliceText(slice, translated, primaryDef, "translate"))
    } catch (err) {
      if (!(err instanceof PageSaveRefusedError)) {
        console.error(err)
        toast.error(t("translationFailed"))
      }
    }
    setBusy(false)
  }

  async function write() {
    if (!generate) return
    if (!(await confirmOverwrite("write"))) return
    const brief = await promptUser({
      title: t("write.title", { label: sliceLabel }),
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
    setBusy(true)
    try {
      const generated = await generate.runSlice(sliceTypeOf(slice), brief)
      // mergeSliceText keeps the slice's id/enabled and structural fields
      // (image, alignment, button hrefs) while overlaying every editorial
      // text field. It walks max(target, source) so a fresh empty slice
      // picks up the generated buttons too.
      onChange(mergeSliceText(slice, generated, primaryDef, "write"))
    } catch (err) {
      if (!(err instanceof PageSaveRefusedError)) {
        console.error(err)
        toast.error(t("generationFailed"))
      }
    }
    setBusy(false)
  }

  const btn =
    "flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline disabled:hover:text-muted-foreground"

  return (
    <div className="flex items-center justify-end gap-3 border-b pb-2">
      <span className="mr-auto text-xs font-medium text-muted-foreground">
        {t("wholeSlice")}
      </span>
      {generate && (
        <button
          type="button"
          onClick={write}
          disabled={busy}
          title={t("writeWithAiTitle")}
          className={btn}
        >
          {busy ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <PencilLine className="size-3" />
          )}
          {t("writeWithAi")}
        </button>
      )}
      {translate && (
        <>
          <button
            type="button"
            onClick={copy}
            disabled={!hasSource || busy}
            title={
              hasSource
                ? t("copyTitle", { locale: loc ?? "" })
                : t("noMatchTitle", { locale: loc ?? "" })
            }
            className={btn}
          >
            <Copy className="size-3" />
            {t("copyFrom", { locale: loc ?? "" })}
          </button>
          {translate.runSlice && (
            <button
              type="button"
              onClick={translateSlice}
              disabled={!hasSource || busy}
              title={
                hasSource
                  ? t("translateTitle", { locale: loc ?? "" })
                  : t("noMatchTitle", { locale: loc ?? "" })
              }
              className={btn}
            >
              {busy ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Sparkles className="size-3" />
              )}
              {t("translateFrom", { locale: loc ?? "" })}
            </button>
          )}
        </>
      )}
    </div>
  )
}
