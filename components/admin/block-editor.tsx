"use client"

import { readBlockDefinition } from "@/convex/lib/blocks"
import { readBlock, blockTypeOf } from "@/convex/lib/blocks/identity"

import { adminBlockMetadata } from "@/lib/i18n/admin-metadata"

import { useState } from "react"
import { validate } from "convex-helpers/validators"
import { button, list } from "@/convex/lib/blocks"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  Copy,
  Loader2,
  Sparkles,
  PencilLine,
  AlertTriangle,
} from "lucide-react"
import { type Block, type Primitive } from "@/convex/lib/blocks"
import {
  GroupFields,
  ListItemsEditor,
  type FieldTranslate,
  type FieldGenerate,
} from "./fields/field-editor"
import { ButtonsEditor } from "./fields/buttons-editor"
import { useConfirm, usePrompt } from "@/components/providers/confirm-provider"
import { mergeBlockText, blockHasContent } from "./block-editor-text"
import { PageSaveRefusedError } from "@/components/admin/page-editor/lib/page-save-refused-error"
import type { BlockPresentationCatalog } from "@/convex/lib/blocks/presentationResolution"
import {
  BlockPresentationSelector,
  type BlockPresentationContext,
} from "./block-presentation-selector"

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
 * Shown when a stored block's `type` is absent from the registry (a retired or
 * renamed block type). Mirrors the public {@link FallbackBlock}: the page never
 * breaks, and the builder's remove control lets the editor delete the orphan.
 */
function UnknownBlockNotice({ type }: { type: string }) {
  const t = useTranslations("editor.blockEditor")
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
 * Generic, schema-driven block editor (ADR-0008, Phase C). Walks the block's
 * `primary` group from the registry instead of hand-coding a form per type;
 * button `items` still use the bespoke {@link ButtonsEditor}, while other
 * bounded item lists use the generic group-list editor.
 *
 * `sourceBlock` is the same-position, same-type block from the translation
 * source locale (resolved in block-builder); it feeds per-field translation
 * pulls and the block-level toolbar. It is undefined when no source locale has
 * content or the structures have diverged, which disables those affordances.
 */
export function BlockEditor({
  block,
  onChange,
  locale,
  sourceBlock,
  translate,
  generate,
  presentationCatalog,
  presentationContext,
}: {
  block: Block
  onChange: (block: Block) => void
  locale: string
  sourceBlock?: Block
  translate?: FieldTranslate
  generate?: FieldGenerate
  presentationCatalog?: BlockPresentationCatalog
  presentationContext?: BlockPresentationContext
}) {
  const t = useTranslations("editor.blockEditor")
  const def = readBlockDefinition(readBlock(block).type)
  // The stored page may carry a block whose type is no longer registered (a
  // retired/renamed block type). Degrade gracefully like the public-side
  // FallbackBlock instead of crashing the whole page editor — the builder's
  // remove button stays available so the editor can delete the orphan.
  if (!def) return <UnknownBlockNotice type={readBlock(block).type} />
  const itemsDef = def.items
  const hasItems = itemsDef !== undefined
  const hasButtonItems = hasItems && isButtonList(itemsDef)
  const buttonItems: unknown = "items" in block ? readBlock(block).items : []
  const validButtonItems = validate(buttonItemsValidator, buttonItems)
  if (hasButtonItems && !validButtonItems)
    throw new Error("Invalid button items.")
  return (
    <div className="space-y-4">
      <BlockPresentationSelector
        block={block}
        catalog={presentationCatalog}
        context={presentationContext}
        onChange={onChange}
      />
      {(translate || generate) && (
        <BlockToolbar
          block={block}
          onChange={onChange}
          sourceBlock={sourceBlock}
          translate={translate}
          generate={generate}
          primaryDef={def.primary}
        />
      )}
      <GroupFields
        def={def.primary}
        value={readBlock(block).primary}
        onChange={(primary) =>
          onChange(Object.assign({}, block, { primary }) as Block)
        }
        locale={locale}
        sourcePrimary={
          readBlock(sourceBlock)?.primary as Record<string, unknown> | undefined
        }
        translate={translate}
        generate={generate}
        blockType={readBlock(block).type}
      />
      {hasButtonItems && (
        <ButtonsEditor
          locale={locale}
          value={validButtonItems ? buttonItems : []}
          onChange={(items) => onChange(Object.assign({}, block, { items }))}
          basePath="items"
        />
      )}
      {hasItems && !hasButtonItems && (
        <ListItemsEditor
          label={t("items")}
          def={itemsDef}
          value={(block as { items?: unknown[] }).items ?? []}
          onChange={(items) => onChange(Object.assign({}, block, { items }))}
          basePath="items"
          locale={locale}
          sourceValue={
            (sourceBlock as { items?: unknown[] } | undefined)?.items
          }
          translate={translate}
          generate={generate}
          blockType={readBlock(block).type}
        />
      )}
    </div>
  )
}

/**
 * Whole-block actions row. Renders only the actions wired by the host:
 * Write with AI (when `generate` is set), Copy / Translate from another locale
 * (when `translate` is set). All actions act on every text field of the block
 * at once, leaving image / layout / selects / link hrefs untouched.
 *
 * Bundled into one row so a bilingual page with AI configured doesn't show
 * two stacked "Whole block" toolbars.
 */
function BlockToolbar({
  block,
  onChange,
  sourceBlock,
  translate,
  generate,
  primaryDef,
}: {
  block: Block
  onChange: (block: Block) => void
  sourceBlock?: Block
  translate?: FieldTranslate
  generate?: FieldGenerate
  primaryDef: Primitive
}) {
  const t = useTranslations("editor.blockEditor")
  const tMetadata = useTranslations("metadata")
  const confirm = useConfirm()
  const promptUser = usePrompt()
  const [busy, setBusy] = useState(false)
  const loc = translate?.sourceLocale.toUpperCase()
  const hasSource = !!sourceBlock
  const blockLabel =
    adminBlockMetadata(readBlock(block).type, tMetadata)?.label ??
    readBlock(block).type

  async function confirmOverwrite(
    action: "copy" | "translate" | "write"
  ): Promise<boolean> {
    if (!blockHasContent(block, primaryDef)) return true
    const description =
      action === "copy"
        ? t("overwrite.copy", { locale: loc ?? "" })
        : action === "translate"
          ? t("overwrite.translate", { locale: loc ?? "" })
          : t("overwrite.write")
    return confirm({
      title: t("overwrite.title", { label: blockLabel }),
      description,
      confirmText: t("overwrite.action"),
      destructive: true,
    })
  }

  async function copy() {
    if (!translate || !sourceBlock) return
    if (!(await confirmOverwrite("copy"))) return
    onChange(mergeBlockText(block, sourceBlock, primaryDef, "copy"))
  }

  async function translateBlock() {
    if (!translate?.runBlock || !sourceBlock) return
    if (!(await confirmOverwrite("translate"))) return
    setBusy(true)
    try {
      const translated = await translate.runBlock(sourceBlock)
      onChange(mergeBlockText(block, translated, primaryDef, "translate"))
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
      title: t("write.title", { label: blockLabel }),
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
      const generated = await generate.runBlock(blockTypeOf(block), brief)
      // mergeBlockText keeps the block's id/enabled and structural fields
      // (image, alignment, button hrefs) while overlaying every editorial
      // text field. It walks max(target, source) so a fresh empty block
      // picks up the generated buttons too.
      onChange(mergeBlockText(block, generated, primaryDef, "write"))
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
        {t("wholeBlock")}
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
          {translate.runBlock && (
            <button
              type="button"
              onClick={translateBlock}
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
