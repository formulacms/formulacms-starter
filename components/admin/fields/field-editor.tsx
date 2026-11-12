"use client"

import { adminFieldMetadata } from "@/lib/i18n/admin-metadata"
import { markStructuralListOperation } from "@/lib/editor-structure"

import dynamic from "next/dynamic"
import { useId, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  FileDown,
  GripVertical,
  Loader2,
  PencilLine,
  Plus,
  Sparkles,
  Table2,
  Trash2,
  Wand2,
} from "lucide-react"
import type {
  Primitive,
  CMSLinkField,
  ImageField,
  Slice,
} from "@/convex/lib/slices"
import type { RichTextProfile } from "@/convex/lib/richtext/profiles"
import { buildFieldDoc } from "@/convex/lib/richtext/build"
import {
  readFieldText,
  transitionForField,
} from "@/convex/lib/richtext/transitions"
import {
  resolveFieldContract,
  type FieldAddress,
  type FieldContract,
  type HeadingRole,
} from "@/convex/lib/richtext/contracts"
import { toFieldShape } from "@/convex/lib/richtext/shape"
import { ImageFieldEditor } from "./image-field-editor"
import { PageSaveRefusedError } from "@/components/admin/page-editor/lib/page-save-refused-error"
import { LinkPagePicker } from "./link-page-picker"
import { MediaPicker } from "../media-picker"
import { RelationPicker, type RelationValue } from "./relation-picker"
import type { PageType } from "@/convex/lib/pages/types"
import { useConfirm, usePrompt } from "@/components/providers/confirm-provider"
import { moveItem, useDragReorder } from "@/lib/use-drag-reorder"
import { listItemKeys } from "@/lib/slices/keys"
import { fieldHasContent, inputClass } from "./field-utils"
import type { LeafEditorKind } from "./editable-kinds"

/**
 * Per-field AI translation (pull model). When the page has another locale with
 * content, `FieldTranslate` carries that source locale + a bound action so a
 * single field can be re-translated in isolation — pulling the source-locale
 * value, translating it, and writing the result back via the field's `onChange`.
 * Only text/richText fields render the affordance, and only when a non-empty
 * source value exists for that field (matching is resolved upstream by slice
 * index + type; see slice-editor.tsx).
 */
export interface FieldTranslate {
  sourceLocale: string
  /** False when whole-page/slice brand translation is available locally but
   *  plain-field translation has no reachable Development or Production route. */
  supportsPlainText: boolean
  /** False when only plain-text translate is available (Development AI lane
   *  without Production AI) — rich-text fields then hide the affordance
   *  instead of rendering a button that can only fail. */
  supportsRichText: boolean
  run: (
    text: string,
    kind: "text" | "richText",
    address?: FieldAddress
  ) => Promise<string>
  /** Translate a whole source slice, returning it with its text fields
   *  translated (structure/marks preserved). Drives the slice-level toolbar.
   *  Absent when whole-slice translate isn't available (Production AI off). */
  runSlice?: (slice: Slice) => Promise<Slice>
}

/**
 * Per-field AI generation (push model — the editor supplies a brief, the agent
 * writes content for one field). Phase-1 tracer of the content writer agent
 * (ADR-013): proves gating + registry + UI on the cheapest surface before
 * slice-level generation lands. The host (page-editor) supplies the action,
 * locale, and slice-type context so callsites don't have to know about Convex.
 */
export interface FieldGenerate {
  /** Run a field-level generation. `profile` is required when `kind` is
   *  "richText"; the agent serializes its output as PM-JSON via buildPMDoc. */
  run: (
    brief: string,
    fieldLabel: string,
    kind: "text" | "richText",
    profile?: RichTextProfile,
    contract?: FieldContract,
    headingRole?: HeadingRole
  ) => Promise<string>
  /** Rewrite the current value following a steering instruction. Rich-text
   *  refinement walks the PM tree per text node — marks (bold/italic/link)
   *  and structure survive. */
  runRefine: (
    text: string,
    instruction: string,
    fieldLabel: string,
    kind: "text" | "richText"
  ) => Promise<string>
  /** Generate a whole slice (one model call) and return the populated form.
   *  Drives the slice-level "Write with AI" toolbar. The slice's id and
   *  `enabled` are preserved by the caller; this returns only the editorial
   *  shape with structural fields at their schema defaults. */
  runSlice: (sliceType: Slice["type"], brief: string) => Promise<Slice>
  /** Operator-curated picker entries the Write dialog renders as a dropdown
   *  above the brief input. Empty / undefined hides the picker. */
  writeBriefs?: ReadonlyArray<{ label: string; body: string }>
  /** Operator-curated picker entries the Refine dialog renders as chips above
   *  the instruction input. Empty / undefined hides the picker. */
  refinePresets?: ReadonlyArray<{ label: string; body: string }>
}

/**
 * Schema-driven field editors (ADR-0008, Phase C). A slice's `primary` group is
 * a list of primitive descriptors; this walks them and renders one widget per
 * field, dispatched by `kind` and parameterized by the primitive's `config`.
 * That kills the per-slice form duplication — adding/changing a field is now a
 * one-place edit in the slice def, and the config drives the widget.
 *
 * Scope (avoid creep): only the leaf kinds that actually appear in slice
 * groups are registered (text, richText, select, number, image). Button lists
 * keep their bespoke editor; other bounded group lists use `ListItemsEditor`.
 */

// TipTap is client-only — never SSR it.
const RichTextEditor = dynamic(
  () => import("../rich-text-editor").then((m) => m.RichTextEditor),
  {
    ssr: false,
    loading: () => (
      <div
        className="h-32 rounded-md border bg-muted/30"
        data-slice-field-loading=""
      />
    ),
  }
)

export function Field({
  label,
  action,
  fieldPath,
  children,
}: {
  label: string
  /** Optional control rendered to the right of the label (e.g. AI translate). */
  action?: React.ReactNode
  fieldPath?: string
  children: React.ReactNode | ((controlId: string) => React.ReactNode)
}) {
  const controlId = useId()
  const labelId = `${controlId}-label`
  return (
    <div className="space-y-1.5" data-slice-field-path={fieldPath} role="group" aria-labelledby={labelId}>
      <div className="flex min-h-5 items-center justify-between gap-2">
        <label id={labelId} htmlFor={typeof children === "function" ? controlId : undefined} className="block text-sm font-medium">{label}</label>
        {action}
      </div>
      {typeof children === "function" ? children(controlId) : children}
    </div>
  )
}

/**
 * The "Translate" affordance shown at a field's label. Hidden only when the page
 * is monolingual (no `translate` source locale at all). When a source locale
 * exists but has no value for this field, the button shows *disabled* with an
 * explanatory tooltip — so every translatable field carries a consistent control
 * instead of the affordance blinking in and out per field.
 */
export function FieldTranslateButton({
  label,
  sourceValue,
  currentValue,
  kind,
  translate,
  onResult,
  address,
}: {
  /** Field label, named in the overwrite confirm. */
  label?: string
  sourceValue: string | undefined
  /** This field's current value, to confirm before overwriting real content. */
  currentValue: string | undefined
  kind: "text" | "richText"
  translate: FieldTranslate | undefined
  onResult: (value: string) => void
  address?: FieldAddress
}) {
  const t = useTranslations("editor.fields")
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  if (!translate) return null
  if (kind === "text" && !translate.supportsPlainText) return null
  // Rich-text translate needs Production AI; when only the Development lane
  // is available, hide the affordance rather than render a doomed button.
  if (kind === "richText" && !translate.supportsRichText) return null
  const hasSource = !!sourceValue
  async function run() {
    if (!translate || !sourceValue) return
    // Translation replaces the field in place. Filling an empty field is
    // frictionless; replacing existing content asks first, so a stray click on a
    // populated locale can't silently destroy work.
    if (fieldHasContent(currentValue)) {
      const ok = await confirm({
        title: label ? t("replace.namedTitle", { label }) : t("replace.title"),
        description: t("replace.translationDescription", {
          locale: translate.sourceLocale.toUpperCase(),
        }),
        confirmText: t("replace.action"),
        destructive: true,
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      onResult(await translate.run(sourceValue, kind, address))
    } catch (err) {
      // A refused Save already told the owner why.
      if (!(err instanceof PageSaveRefusedError)) {
        console.error(err)
        toast.error(t("translationFailed"))
      }
    }
    setBusy(false)
  }
  return (
    <button
      type="button"
      onClick={run}
      disabled={busy || !hasSource}
      title={
        hasSource
          ? t("translateTitle", {
              locale: translate.sourceLocale.toUpperCase(),
            })
          : t("nothingToTranslate", {
              locale: translate.sourceLocale.toUpperCase(),
            })
      }
      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-40 disabled:hover:text-muted-foreground"
    >
      {busy ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <Sparkles className="size-3" />
      )}
      {t("translate")}
    </button>
  )
}

// Module-level so the component bodies hold no unsupported statements. React
// Compiler 1.0.0 silently skips a whole component that contains a `finally`, a
// `throw` inside `try`, or value blocks (optional chaining, `??`, ternaries)
// inside try/catch (react/react#34131, #35605, #35573); ESLint still passes
// (react/react#37789). The work still runs inside the try, so errors map as
// before. `page-editor/compiler-coverage.node.test.ts` guards the result.

async function tryAsync(
  run: () => Promise<void>,
  onError: (err: unknown) => void
): Promise<void> {
  try {
    await run()
  } catch (err) {
    onError(err)
  }
}

/**
 * "Write with AI" button — Phase-1 tracer of the content writer agent. Prompts
 * for a short brief, calls the bound generate action, writes the result back
 * via `onResult`. Hidden when no `generate` is supplied (host hides it for
 * roles without `content:ai` and when AI isn't configured). Asks before
 * overwriting real content, mirroring the translate flow.
 */
export function FieldWriteButton({
  label,
  currentValue,
  kind,
  profile,
  generate,
  onResult,
}: {
  label?: string
  currentValue: string | undefined
  kind: "text" | "richText"
  profile?: RichTextProfile
  generate: FieldGenerate | undefined
  onResult: (value: string) => void
}) {
  const t = useTranslations("editor.fields")
  const promptUser = usePrompt()
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  if (!generate) return null
  async function run() {
    if (!generate) return
    if (fieldHasContent(currentValue)) {
      const ok = await confirm({
        title: label ? t("replace.namedTitle", { label }) : t("replace.title"),
        description: t("replace.writeDescription"),
        confirmText: t("replace.action"),
        destructive: true,
      })
      if (!ok) return
    }
    const brief = await promptUser({
      title: label ? t("write.namedTitle", { label }) : t("write.title"),
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
    await tryAsync(
      async () => {
        onResult(
          await generate.run(brief, label ?? t("genericField"), kind, profile)
        )
      },
      (err) => {
        if (!(err instanceof PageSaveRefusedError)) {
          console.error(err)
          toast.error(t("generationFailed"))
        }
      }
    )
    setBusy(false)
  }
  return (
    <button
      type="button"
      onClick={run}
      disabled={busy}
      title={t("writeWithAiTitle")}
      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:opacity-40"
    >
      {busy ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <PencilLine className="size-3" />
      )}
      {t("write.action")}
    </button>
  )
}

/**
 * "Refine with AI" button — steers an existing field with a short instruction
 * (e.g. "make this shorter", "more humane tone"). Disabled when the field is
 * empty (refine has nothing to operate on). The source content carries the
 * voice and topic, so refine doesn't carry the slop risk of cold-start Write.
 */
export function FieldRefineButton({
  label,
  currentValue,
  kind,
  generate,
  onResult,
}: {
  label?: string
  currentValue: string | undefined
  kind: "text" | "richText"
  generate: FieldGenerate | undefined
  onResult: (value: string) => void
}) {
  const t = useTranslations("editor.fields")
  const promptUser = usePrompt()
  const [busy, setBusy] = useState(false)
  if (!generate) return null
  const hasContent = fieldHasContent(currentValue)
  async function run() {
    if (!generate || !currentValue) return
    // Rich-text Refine is per-text-node: each segment is rewritten in place
    // so marks (bold/italic/link) survive. The trade-off is that restructuring
    // instructions (merging paragraphs, "shorten overall") can't compose
    // across segments. Surface that up front so the user reaches for Write
    // instead of fighting the limitation.
    const restructuringHint =
      kind === "richText" ? t("refine.restructuringHint") : ""
    const instruction = await promptUser({
      title: label ? t("refine.namedTitle", { label }) : t("refine.title"),
      description: t("refine.description") + restructuringHint,
      label: t("refine.instruction"),
      placeholder: t("refine.placeholder"),
      confirmText: t("refine.action"),
      presets: generate.refinePresets as
        { label: string; body: string }[] | undefined,
      presetsVariant: "chips",
      presetsLabel: t("refine.presets"),
    })
    if (!instruction) return
    setBusy(true)
    await tryAsync(
      async () => {
        onResult(
          await generate.runRefine(
            currentValue,
            instruction,
            label ?? t("genericField"),
            kind
          )
        )
      },
      (err) => {
        if (!(err instanceof PageSaveRefusedError)) {
          console.error(err)
          toast.error(t("refinementFailed"))
        }
      }
    )
    setBusy(false)
  }
  return (
    <button
      type="button"
      onClick={run}
      disabled={busy || !hasContent}
      title={hasContent ? t("refineTitle") : t("nothingToRefine")}
      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-40 disabled:hover:text-muted-foreground"
    >
      {busy ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <Wand2 className="size-3" />
      )}
      {t("refine.action")}
    </button>
  )
}

/** Field-level locale + AI actions. Copy is intentionally page/slice-level only. */
export function FieldLocaleActions({
  label,
  sourceValue,
  currentValue,
  kind,
  profile,
  translate,
  generate,
  onResult,
  address,
}: {
  /** Field label, named in the overwrite confirms. */
  label?: string
  sourceValue: string | undefined
  currentValue: string | undefined
  kind: "text" | "richText"
  profile?: RichTextProfile
  translate: FieldTranslate | undefined
  generate: FieldGenerate | undefined
  onResult: (value: string) => void
  address?: FieldAddress
}) {
  if (!translate && !generate) return null
  return (
    <div className="flex items-center gap-3">
      <FieldWriteButton
        label={label}
        currentValue={currentValue}
        kind={kind}
        profile={profile}
        generate={generate}
        onResult={onResult}
      />
      <FieldRefineButton
        label={label}
        currentValue={currentValue}
        kind={kind}
        generate={generate}
        onResult={onResult}
      />
      <FieldTranslateButton
        label={label}
        sourceValue={sourceValue}
        currentValue={currentValue}
        kind={kind}
        translate={translate}
        address={address}
        onResult={onResult}
      />
    </div>
  )
}

/** camelCase / kebab / snake → "Title Case", for field labels and option values. */
function humanize(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

interface WidgetProps {
  label: string
  fieldPath: string
  def: Primitive
  value: unknown
  /** When true, an emptied value is written back as `undefined` (omitted). */
  optional: boolean
  onChange: (value: unknown) => void
  /** Active content locale used by locale-aware reference widgets. */
  locale: string
  sliceType?: string
  /** Source-locale value for this field, when a translate source is available. */
  sourceValue?: unknown
  /** Bound per-field AI translate API; absent when no source locale has content. */
  translate?: FieldTranslate
  /** Bound per-field AI generate API; absent when AI isn't configured or the
   *  current user lacks `content:ai`. */
  generate?: FieldGenerate
}

function TextWidget({
  label,
  fieldPath,
  def,
  value,
  optional,
  onChange,
  sourceValue,
  translate,
  generate,
  sliceType,
}: WidgetProps) {
  const cfg = def.config as {
    multiline?: boolean
    maxLength?: number
    placeholder?: string
  }
  const address = sliceType ? { sliceType, fieldPath } : undefined
  const str = readFieldText(address, (value as string) ?? "")
  const source =
    typeof sourceValue === "string"
      ? readFieldText(address, sourceValue)
      : undefined
  const transitionMultiline =
    transitionForField(address) !== undefined &&
    (str.includes("\n") || source?.includes("\n") === true)
  const set = (s: string) => {
    const next = optional ? s || undefined : s
    onChange(
      typeof next === "string" &&
        def.kind === "richText" &&
        transitionForField(address)
        ? JSON.stringify(buildFieldDoc(next, def.config, "itemTitle"))
        : next
    )
  }
  return (
    <Field
      label={label}
      fieldPath={fieldPath}
      action={
        <FieldLocaleActions
          label={label}
          sourceValue={source}
          currentValue={str}
          kind="text"
          translate={translate}
          address={address}
          generate={generate}
          onResult={set}
        />
      }
    >
      {(controlId) => (<>
      {cfg.multiline || transitionMultiline ? (
        <textarea
          id={controlId}
          value={str}
          onChange={(e) => set(e.target.value)}
          rows={3}
          maxLength={cfg.maxLength}
          placeholder={cfg.placeholder}
          aria-label={label}
          className={`${inputClass} resize-y`}
        />
      ) : (
        <input
          id={controlId}
          type="text"
          value={str}
          onChange={(e) => set(e.target.value)}
          maxLength={cfg.maxLength}
          placeholder={cfg.placeholder}
          aria-label={label}
          className={inputClass}
        />
      )}
      </>)}
    </Field>
  )
}

function RichTextWidget({
  label,
  fieldPath,
  def,
  value,
  onChange,
  sourceValue,
  translate,
  generate,
}: WidgetProps) {
  const contract = resolveFieldContract(
    def.config as {
      profile?: RichTextProfile
      contract?: "title" | RichTextProfile
    }
  )
  const profile = contract.profile ?? "inline"
  // Keep title source bytes until parent adoption can retain located reports.
  const currentValue =
    contract.contract === "title"
      ? ((value as string) ?? "")
      : toFieldShape(contract, (value as string) ?? "").value
  const currentSource =
    typeof sourceValue === "string"
      ? contract.contract === "title"
        ? sourceValue
        : toFieldShape(contract, sourceValue).value
      : undefined
  const fieldGenerate = generate
    ? {
        ...generate,
        run: (
          brief: string,
          fieldLabel: string,
          kind: "text" | "richText",
          fieldProfile?: RichTextProfile
        ) =>
          generate.run(
            brief,
            fieldLabel,
            kind,
            fieldProfile,
            contract.contract,
            contract.contract === "title" ? contract.headingRole : undefined
          ),
      }
    : undefined
  return (
    <Field
      label={label}
      fieldPath={fieldPath}
      action={
        <FieldLocaleActions
          label={label}
          sourceValue={currentSource}
          currentValue={currentValue}
          kind="richText"
          profile={profile}
          translate={translate}
          generate={fieldGenerate}
          onResult={onChange}
        />
      }
    >
      {(controlId) => (<>
      <RichTextEditor
        id={controlId}
        value={currentValue}
        onChange={onChange}
        profile={profile}
        contract={contract.contract === "title" ? "title" : undefined}
        label={label}
        sourceValue={currentSource}
        translate={translate}
        generate={fieldGenerate}
      />
      </>)}
    </Field>
  )
}

function SelectWidget({ label, fieldPath, def, value, onChange }: WidgetProps) {
  const cfg = def.config as {
    options: readonly string[]
    default: string
    labels?: Record<string, string>
  }
  const val = (value as string) ?? cfg.default
  return (
    <Field label={label} fieldPath={fieldPath}>
      {(controlId) => (<>
      <select
        id={controlId}
        value={val}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass}
      >
        {cfg.options.map((opt) => (
          <option key={opt} value={opt}>
            {cfg.labels?.[opt] ?? humanize(opt)}
          </option>
        ))}
      </select>
      </>)}
    </Field>
  )
}

function BooleanWidget({
  label,
  fieldPath,
  def,
  value,
  onChange,
}: WidgetProps) {
  const cfg = def.config as {
    label?: string
    description?: string
    default: boolean
  }
  const checked = typeof value === "boolean" ? value : cfg.default
  return (
    <Field label={label} fieldPath={fieldPath}>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="block">{cfg.label ?? label}</span>
          {cfg.description && (
            <span className="block text-xs text-muted-foreground">
              {cfg.description}
            </span>
          )}
        </span>
      </label>
    </Field>
  )
}

function NumberWidget({
  label,
  fieldPath,
  def,
  value,
  optional,
  onChange,
}: WidgetProps) {
  const cfg = def.config as {
    min?: number
    max?: number
    step?: number
    default: number
  }
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <Field label={label} fieldPath={fieldPath}>
      {(controlId) => (<>
      <input
        id={controlId}
        type="number"
        min={cfg.min}
        max={cfg.max}
        step={cfg.step}
        aria-label={label}
        value={editing ?? (value === undefined ? "" : String(value))}
        onFocus={(event) => setEditing(event.currentTarget.value)}
        onChange={(event) => {
          const next = event.currentTarget.value
          setEditing(next)
          // Native number inputs retain incomplete signs/decimal separators
          // while focused. Do not replace them with a persisted default.
          if (next !== "" && Number.isFinite(Number(next))) onChange(Number(next))
        }}
        onBlur={(event) => {
          if (event.currentTarget.value === "") {
            onChange(optional ? undefined : cfg.default)
          }
          setEditing(null)
        }}
        className={inputClass}
      />
      </>)}
    </Field>
  )
}

function ImageWidget({ label, fieldPath, value, onChange }: WidgetProps) {
  return (
    <div data-slice-field-path={fieldPath}>
      <ImageFieldEditor
        label={label}
        value={value as ImageField | undefined}
        onChange={(img) => onChange(img)}
      />
    </div>
  )
}

const LINK_TYPES = ["internal", "external", "anchor", "media", "none"] as const

function LinkWidget({
  label,
  fieldPath,
  value,
  onChange,
  locale,
}: WidgetProps) {
  const t = useTranslations("editor.fields")
  const link = ((value as CMSLinkField | undefined) ?? {
    type: "none",
  }) as CMSLinkField
  const [mediaOpen, setMediaOpen] = useState(false)
  const linkTypeLabels: Record<(typeof LINK_TYPES)[number], string> = {
    internal: t("link.types.internal"),
    external: t("link.types.external"),
    anchor: t("link.types.anchor"),
    media: t("link.types.media"),
    none: t("link.types.none"),
  }

  function patch(patch: Partial<CMSLinkField>) {
    onChange({ ...link, ...patch })
  }

  return (
    <Field label={label} fieldPath={fieldPath}>
      {(controlId) => (<>
      <div className="space-y-2">
        <select
        id={controlId}
          value={link.type}
          onChange={(event) =>
            patch({ type: event.target.value as CMSLinkField["type"] })
          }
          className={inputClass}
        >
          {LINK_TYPES.map((type) => (
            <option key={type} value={type}>
              {linkTypeLabels[type]}
            </option>
          ))}
        </select>

        {link.type === "internal" && (
          <LinkPagePicker
            value={link.pageId}
            onChange={(pageId) => patch({ pageId })}
            locale={locale}
          />
        )}

        {link.type === "external" && (
          <input
            type="url"
            value={link.url ?? ""}
            onChange={(event) => patch({ url: event.target.value })}
            placeholder={t("link.externalPlaceholder")}
            aria-label={t("link.externalLabel", { label })}
            className={inputClass}
          />
        )}

        {link.type === "anchor" && (
          <input
            type="text"
            value={link.anchor ?? ""}
            onChange={(event) => patch({ anchor: event.target.value })}
            placeholder={t("link.anchorPlaceholder")}
            aria-label={t("link.anchorLabel", { label })}
            className={inputClass}
          />
        )}

        {link.type === "media" && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMediaOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-accent/50"
            >
              <FileDown className="size-4" />
              {link.url ? t("link.changeMedia") : t("link.chooseMedia")}
            </button>
            {link.url && (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {link.url}
              </span>
            )}
            <MediaPicker
              open={mediaOpen}
              onOpenChange={setMediaOpen}
              onSelect={(image, media) =>
                patch({
                  type: "media",
                  mediaId: media._id,
                  storageId: image.storageId,
                  url: image.url,
                })
              }
            />
          </div>
        )}
      </div>
      </>)}
    </Field>
  )
}

function DateWidget({
  label,
  fieldPath,
  def,
  value,
  optional,
  onChange,
}: WidgetProps) {
  const isDateTime = def.kind === "datetime"
  const str = typeof value === "string" ? value : ""
  const inputValue =
    isDateTime && str ? str.replace(/Z$/, "").slice(0, 16) : str
  return (
    <Field label={label} fieldPath={fieldPath}>
      {(controlId) => (<>
      <input
        id={controlId}
        type={isDateTime ? "datetime-local" : "date"}
        value={inputValue}
        onChange={(event) => {
          const next = event.target.value
          if (!next) {
            onChange(optional ? undefined : "")
            return
          }
          onChange(isDateTime ? new Date(next).toISOString() : next)
        }}
        placeholder={(def.config as { placeholder?: string }).placeholder}
        aria-label={label}
        className={inputClass}
      />
      </>)}
    </Field>
  )
}

function GeopointWidget({
  label,
  fieldPath,
  value,
  optional,
  onChange,
}: WidgetProps) {
  const t = useTranslations("editor.fields")
  const point =
    value && typeof value === "object"
      ? (value as { lat?: number; lng?: number })
      : {}

  function set(axis: "lat" | "lng", raw: string) {
    const next = { ...point, [axis]: raw === "" ? undefined : Number(raw) }
    if (
      optional &&
      typeof next.lat !== "number" &&
      typeof next.lng !== "number"
    ) {
      onChange(undefined)
      return
    }
    onChange(next)
  }

  return (
    <Field label={label} fieldPath={fieldPath}>
      <div className="grid grid-cols-2 gap-2">
        <input
          type="number"
          step="0.000001"
          value={point.lat ?? ""}
          onChange={(event) => set("lat", event.target.value)}
          placeholder={t("geopoint.latitude")}
          aria-label={t("geopoint.latitudeLabel", { label })}
          className={inputClass}
        />
        <input
          type="number"
          step="0.000001"
          value={point.lng ?? ""}
          onChange={(event) => set("lng", event.target.value)}
          placeholder={t("geopoint.longitude")}
          aria-label={t("geopoint.longitudeLabel", { label })}
          className={inputClass}
        />
      </div>
    </Field>
  )
}

function EmbedWidget({
  label,
  fieldPath,
  def,
  value,
  optional,
  onChange,
}: WidgetProps) {
  const t = useTranslations("editor.fields")
  const embed =
    value && typeof value === "object"
      ? (value as { url?: string; provider?: string; title?: string })
      : { url: "" }

  function patch(patch: Partial<typeof embed>) {
    const next = { ...embed, ...patch }
    if (
      optional &&
      !next.url?.trim() &&
      !next.provider?.trim() &&
      !next.title?.trim()
    ) {
      onChange(undefined)
      return
    }
    onChange({
      url: next.url ?? "",
      ...(next.provider ? { provider: next.provider } : {}),
      ...(next.title ? { title: next.title } : {}),
    })
  }

  return (
    <Field label={label} fieldPath={fieldPath}>
      <div className="space-y-2">
        <input
          type="url"
          value={embed.url ?? ""}
          onChange={(event) => patch({ url: event.target.value })}
          placeholder={
            (def.config as { placeholder?: string }).placeholder ??
            t("embed.urlPlaceholder")
          }
          aria-label={t("embed.urlLabel", { label })}
          className={inputClass}
        />
        <div className="grid grid-cols-2 gap-2">
          <input
            type="text"
            value={embed.provider ?? ""}
            onChange={(event) => patch({ provider: event.target.value })}
            placeholder={t("embed.provider")}
            aria-label={t("embed.providerLabel", { label })}
            className={inputClass}
          />
          <input
            type="text"
            value={embed.title ?? ""}
            onChange={(event) => patch({ title: event.target.value })}
            placeholder={t("embed.title")}
            aria-label={t("embed.titleLabel", { label })}
            className={inputClass}
          />
        </div>
      </div>
    </Field>
  )
}

function TableWidget({ label, fieldPath, def, value, onChange }: WidgetProps) {
  const t = useTranslations("editor.fields")
  const cfg = def.config as { minColumns?: number; maxColumns?: number }
  const table =
    value && typeof value === "object"
      ? (value as { headerRow?: string[]; rows?: string[][] })
      : { rows: [] }
  const rows = Array.isArray(table.rows) ? table.rows : []
  const minColumns = Math.max(1, cfg.minColumns ?? 1)
  const maxColumns = cfg.maxColumns ?? 12
  const columnCount = Math.min(
    maxColumns,
    Math.max(
      minColumns,
      table.headerRow?.length ?? 0,
      ...rows.map((row) => row.length)
    )
  )
  const hasHeader = Array.isArray(table.headerRow)

  function normalizeRow(row: string[]): string[] {
    return Array.from({ length: columnCount }, (_, i) => row[i] ?? "")
  }

  function emit(next: { headerRow?: string[]; rows: string[][] }) {
    onChange(next)
  }

  function setCell(rowIndex: number, columnIndex: number, cell: string) {
    emit({
      ...(hasHeader ? { headerRow: normalizeRow(table.headerRow ?? []) } : {}),
      rows: rows.map((row, i) =>
        i === rowIndex
          ? normalizeRow(row).map((current, c) =>
              c === columnIndex ? cell : current
            )
          : normalizeRow(row)
      ),
    })
  }

  function setHeader(columnIndex: number, cell: string) {
    emit({
      headerRow: normalizeRow(table.headerRow ?? []).map((current, c) =>
        c === columnIndex ? cell : current
      ),
      rows: rows.map(normalizeRow),
    })
  }

  function addRow() {
    emit({
      ...(hasHeader ? { headerRow: normalizeRow(table.headerRow ?? []) } : {}),
      rows: [...rows.map(normalizeRow), Array(columnCount).fill("")],
    })
  }

  function addColumn() {
    if (columnCount >= maxColumns) return
    emit({
      ...(hasHeader
        ? { headerRow: [...normalizeRow(table.headerRow ?? []), ""] }
        : {}),
      rows: rows.map((row) => [...normalizeRow(row), ""]),
    })
  }

  function removeColumn(index: number) {
    if (columnCount <= minColumns) return
    emit({
      ...(hasHeader
        ? {
            headerRow: normalizeRow(table.headerRow ?? []).filter(
              (_, i) => i !== index
            ),
          }
        : {}),
      rows: rows.map((row) => normalizeRow(row).filter((_, i) => i !== index)),
    })
  }

  function removeRow(index: number) {
    const nextRows: string[][] = []
    for (let i = 0; i < rows.length; i++) {
      if (i !== index) nextRows.push(normalizeRow(rows[i]))
    }
    emit({
      ...(hasHeader ? { headerRow: normalizeRow(table.headerRow ?? []) } : {}),
      rows: nextRows,
    })
  }

  return (
    <Field label={label} fieldPath={fieldPath}>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={hasHeader}
              onChange={(event) =>
                emit({
                  ...(event.target.checked
                    ? { headerRow: Array(columnCount).fill("") }
                    : {}),
                  rows: rows.map(normalizeRow),
                })
              }
            />
            {t("table.headerRow")}
          </label>
          <button
            type="button"
            onClick={addRow}
            className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Plus className="size-3.5" />
            {t("table.row")}
          </button>
          <button
            type="button"
            onClick={addColumn}
            disabled={columnCount >= maxColumns}
            className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            <Plus className="size-3.5" />
            {t("table.column")}
          </button>
        </div>

        <div className="overflow-x-auto rounded-md border">
          <table className="min-w-full border-collapse text-sm">
            {hasHeader && (
              <thead>
                <tr className="bg-muted/40">
                  {normalizeRow(table.headerRow ?? []).map((cell, c) => (
                    <th key={c} className="min-w-32 border-r border-b p-1">
                      <div className="flex items-center gap-1">
                        <input
                          type="text"
                          value={cell}
                          onChange={(event) => setHeader(c, event.target.value)}
                          aria-label={t("table.headerColumnLabel", {
                            label,
                            column: c + 1,
                          })}
                          className="w-full bg-transparent px-2 py-1 font-medium focus:ring-1 focus:ring-ring focus:outline-none"
                        />
                        <button
                          type="button"
                          onClick={() => removeColumn(c)}
                          disabled={columnCount <= minColumns}
                          title={t("table.removeColumn")}
                          className="rounded p-1 text-muted-foreground hover:text-destructive disabled:opacity-30"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td className="p-4 text-center text-xs text-muted-foreground">
                    <Table2 className="mx-auto mb-1 size-4" />
                    {t("table.empty")}
                  </td>
                </tr>
              )}
              {rows.map((row, r) => (
                <tr key={r}>
                  {normalizeRow(row).map((cell, c) => (
                    <td key={c} className="min-w-32 border-r border-b p-1">
                      <input
                        type="text"
                        value={cell}
                        onChange={(event) => setCell(r, c, event.target.value)}
                        aria-label={t("table.cellLabel", {
                          label,
                          row: r + 1,
                          column: c + 1,
                        })}
                        className="w-full bg-transparent px-2 py-1 focus:ring-1 focus:ring-ring focus:outline-none"
                      />
                    </td>
                  ))}
                  <td className="w-9 border-b p-1">
                    <button
                      type="button"
                      onClick={() => removeRow(r)}
                      title={t("table.removeRow")}
                      className="rounded p-1 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Field>
  )
}

function RelationWidget({
  label,
  fieldPath,
  def,
  value,
  optional,
  onChange,
  locale,
}: WidgetProps) {
  const cfg = def.config as {
    pageTypes: readonly PageType[]
    tag?: string
  }
  return (
    <Field label={label} fieldPath={fieldPath}>
      <RelationPicker
        value={value as RelationValue | undefined}
        pageTypes={cfg.pageTypes}
        tag={cfg.tag}
        locale={locale}
        optional={optional}
        onChange={(next) => onChange(next)}
      />
    </Field>
  )
}

/**
 * The field-editor registry, keyed by primitive `kind`. `satisfies
 * Record<LeafEditorKind, …>` makes this the editor-side source of truth: a leaf
 * kind without a widget (or a stray widget for a kind that isn't declared
 * editable) is a tsc error here, and the verify gate rejects any slice whose
 * fields reference a kind outside that same declared set (`editable-kinds.ts`).
 */
const EDITOR_REGISTRY = {
  text: TextWidget,
  richText: RichTextWidget,
  boolean: BooleanWidget,
  select: SelectWidget,
  number: NumberWidget,
  image: ImageWidget,
  link: LinkWidget,
  relation: RelationWidget,
  date: DateWidget,
  datetime: DateWidget,
  geopoint: GeopointWidget,
  embed: EmbedWidget,
  table: TableWidget,
} satisfies Record<LeafEditorKind, (props: WidgetProps) => React.ReactNode>

function FieldEditor({
  name,
  fieldPath,
  def,
  value,
  onChange,
  locale,
  sourceValue,
  translate,
  generate,
  sliceType,
}: {
  name: string
  fieldPath: string
  def: Primitive
  value: unknown
  onChange: (value: unknown) => void
  locale: string
  sourceValue?: unknown
  translate?: FieldTranslate
  generate?: FieldGenerate
  sliceType?: string
}) {
  const t = useTranslations("editor.fields")
  const tMetadata = useTranslations("metadata")
  const metadata = adminFieldMetadata(def, name, tMetadata)
  // Container kinds recurse instead of resolving from the leaf registry, so a
  // `list`/`group` nested inside another group or list (e.g. a tier card's
  // benefit sub-list) is editable at any depth — not just at the top level.
  if (def.kind === "list") {
    return (
      <ListItemsEditor
        label={metadata.label}
        def={def}
        value={value}
        onChange={(next) => onChange(next)}
        basePath={fieldPath}
        locale={locale}
        sourceValue={sourceValue}
        translate={translate}
        generate={generate}
        sliceType={sliceType}
      />
    )
  }
  if (def.kind === "group") {
    return (
      <Field label={metadata.label} fieldPath={fieldPath}>
        <div className="rounded-md border bg-card p-3">
          <GroupFields
            def={def}
            value={value}
            onChange={(next) => onChange(next)}
            basePath={fieldPath}
            locale={locale}
            sourcePrimary={sourceValue as Record<string, unknown> | undefined}
            translate={translate}
            generate={generate}
            sliceType={sliceType}
          />
        </div>
      </Field>
    )
  }

  // FAQ retains its existing plain question control during this storage/kit
  // adoption. A new rich title toolbar is a separately approved UI change.
  const Widget =
    def.kind === "richText" &&
    transitionForField(sliceType ? { sliceType, fieldPath } : undefined)
      ? TextWidget
      : (
          EDITOR_REGISTRY as Record<
            string,
            ((props: WidgetProps) => React.ReactNode) | undefined
          >
        )[def.kind]
  if (!Widget) {
    // A field whose kind has no registered widget — surface it instead of
    // silently dropping it (guards against adding a primitive without an editor).
    return (
      <p className="text-xs text-destructive">
        {t("unsupported", { name, kind: def.kind })}
      </p>
    )
  }
  return (
    <Widget
      label={metadata.label}
      fieldPath={fieldPath}
      def={metadata.def}
      value={value}
      optional={def.validator.isOptional === "optional"}
      onChange={onChange}
      locale={locale}
      sourceValue={typeof sourceValue === "string" ? sourceValue : undefined}
      translate={translate}
      generate={generate}
      sliceType={sliceType}
    />
  )
}

/**
 * Walk a map of primitive descriptors, rendering one editor per field. The
 * descriptor-generic seam that C8 exposes so `ContentTypeFieldsPanel` can
 * render `descriptor.sharedFields` / `descriptor.localizedFields` through the
 * same code path that walks a slice's `primary` group.
 *
 * `dir` is future-proofing for the i18n hardening chunk (plan 029): stamped on
 * the wrapper so child inputs inherit RTL visual direction via CSS. Widget-
 * level `dir` threading (TipTap etc.) is deferred there. Default `"ltr"` keeps
 * every current call-site unchanged.
 */
export function FieldsEditor({
  fields,
  value,
  onChange,
  basePath,
  locale,
  sourceValues,
  translate,
  generate,
  sliceType,
  dir = "ltr",
}: {
  fields: Record<string, Primitive>
  value: Record<string, unknown> | undefined
  onChange: (value: Record<string, unknown>) => void
  basePath: string
  /** Active content locale for locale-aware link/reference widgets. */
  locale: string
  /** Source-locale bag for per-field translation pulls. */
  sourceValues?: Record<string, unknown>
  translate?: FieldTranslate
  generate?: FieldGenerate
  sliceType?: string
  /** Reading direction of the values (not the admin chrome). Default `"ltr"`. */
  dir?: "ltr" | "rtl"
}) {
  const obj = (value ?? {}) as Record<string, unknown>
  return (
    <div className="space-y-4" dir={dir}>
      {Object.entries(fields).map(([key, fieldDef]) => {
        const src = sourceValues?.[key]
        return (
          <FieldEditor
            key={key}
            name={key}
            fieldPath={`${basePath}.${key}`}
            def={fieldDef}
            value={obj[key]}
            onChange={(v) => onChange({ ...obj, [key]: v })}
            locale={locale}
            sourceValue={src}
            translate={translate}
            generate={generate}
            sliceType={sliceType}
          />
        )
      })}
    </div>
  )
}

/**
 * Walk a `group` primitive's fields. Thin wrapper around {@link FieldsEditor}
 * so the slice editor's existing call-sites don't change.
 */
export function GroupFields({
  def,
  value,
  onChange,
  basePath = "primary",
  locale,
  sourcePrimary,
  translate,
  generate,
  sliceType,
}: {
  def: Primitive
  value: unknown
  onChange: (value: Record<string, unknown>) => void
  basePath?: string
  locale: string
  /** The source-locale slice's `primary`, for per-field translation pulls. */
  sourcePrimary?: Record<string, unknown>
  translate?: FieldTranslate
  generate?: FieldGenerate
  sliceType?: string
}) {
  return (
    <FieldsEditor
      fields={def.config.fields as Record<string, Primitive>}
      value={(value ?? {}) as Record<string, unknown>}
      onChange={onChange}
      basePath={basePath}
      locale={locale}
      sourceValues={sourcePrimary}
      translate={translate}
      generate={generate}
      sliceType={sliceType}
    />
  )
}

const EMPTY_LIST_ITEMS: unknown[] = []

export function ListItemsEditor({
  label,
  def,
  value,
  onChange,
  basePath,
  locale,
  sourceValue,
  translate,
  generate,
  sliceType,
}: {
  label: string
  def: Primitive
  value: unknown
  onChange: (value: unknown[]) => void
  basePath: string
  locale: string
  sourceValue?: unknown
  translate?: FieldTranslate
  generate?: FieldGenerate
  sliceType?: string
}) {
  const t = useTranslations("editor.fields")
  const cfg = def.config as { item: Primitive; max?: number }
  const itemDef = cfg.item
  const items = Array.isArray(value) ? value : EMPTY_LIST_ITEMS
  const sourceItems = Array.isArray(sourceValue) ? sourceValue : EMPTY_LIST_ITEMS
  const [identity, setIdentity] = useState(() => ({
    items,
    keys: listItemKeys(items, items.map(() => `itemId:${crypto.randomUUID()}`)),
  }))
  let keys = identity.keys
  if (identity.items !== items) {
    const candidates = listItemKeys(items, ensureKeyCount(keys, items.length))
    const used = new Set<string>()
    keys = items.map((item, index) => {
      const previous = item && typeof item === "object" ? identity.items.indexOf(item) : -1
      const candidate = previous < 0 ? candidates[index] : identity.keys[previous]
      const key = used.has(candidate) ? `itemId:${crypto.randomUUID()}` : candidate
      used.add(key)
      return key
    })
    setIdentity({ items, keys })
  }
  const itemDefault =
    itemDef.default === undefined ? {} : structuredClone(itemDef.default)
  const canAdd = cfg.max === undefined || items.length < cfg.max
  const { dragHandlers } = useDragReorder((from, to) => {
    if (from === to) return
    const next = markStructuralListOperation(moveItem(items, from, to))
    setIdentity({ items: next, keys: moveItem(keys, from, to) })
    onChange(next)
  })

  function addItem() {
    if (!canAdd) return
    const itemId = crypto.randomUUID()
    const next = markStructuralListOperation([
      ...items,
      itemDef.validator.kind === "object"
        ? { ...(structuredClone(itemDefault) as Record<string, unknown>), itemId }
        : structuredClone(itemDefault),
    ])
    setIdentity({ items: next, keys: [...keys, `itemId:${itemId}`] })
    onChange(next)
  }

  function updateItem(index: number, next: unknown) {
    const current = items[index]
    const currentItemId =
      current && typeof current === "object" && !Array.isArray(current)
        ? (current as Record<string, unknown>).itemId
        : undefined
    const preservesObjectIdentity = itemDef.validator.kind === "object"
    const preservesUndefinedObjectRow =
      preservesObjectIdentity &&
      (itemDef.kind === "image" || itemDef.kind === "relation")
    const persistedItemId =
      typeof currentItemId === "string" && currentItemId.trim()
        ? currentItemId
        : keys[index].slice("itemId:".length)
    const replacement = preservesObjectIdentity
      ? next && typeof next === "object" && !Array.isArray(next)
        ? { ...(next as Record<string, unknown>), itemId: persistedItemId }
        : next === undefined && preservesUndefinedObjectRow
          ? { itemId: persistedItemId }
          : next
      : next
    const nextItems = items.map((item, i) => (i === index ? replacement : item))
    setIdentity({ items: nextItems, keys })
    onChange(nextItems)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium">{label}</label>
        <button
          type="button"
          onClick={addItem}
          disabled={!canAdd}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-40"
        >
          <Plus className="size-3.5" />
          {t("list.add")}
        </button>
      </div>

      {items.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("list.empty")}</p>
      )}

      <div className="space-y-2">
        {items.map((item, index) => (
          <div
            key={keys[index]}
            {...dragHandlers(index)}
            className="space-y-3 rounded-md border bg-card p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <GripVertical className="size-4 cursor-grab" />
                {label} {index + 1}
              </div>
              <button
                type="button"
                onClick={() => {
                  const next = markStructuralListOperation(items.filter((_, i) => i !== index))
                  setIdentity({ items: next, keys: keys.filter((_, i) => i !== index) })
                  onChange(next)
                }}
                title={t("list.remove", {
                  label: label.toLowerCase(),
                  index: index + 1,
                })}
                className="rounded p-1 text-muted-foreground transition-colors hover:text-destructive"
              >
                <Trash2 className="size-4" />
              </button>
            </div>

            {itemDef.kind === "group" ? (
              <GroupFields
                def={itemDef}
                value={item}
                onChange={(next) => updateItem(index, next)}
                basePath={`${basePath}.${index}`}
                locale={locale}
                sourcePrimary={
                  sourceItems[index] as Record<string, unknown> | undefined
                }
                translate={translate}
                generate={generate}
                sliceType={sliceType}
              />
            ) : (
              <FieldEditor
                name={`${label} ${index + 1}`}
                fieldPath={`${basePath}.${index}`}
                def={itemDef}
                value={item}
                onChange={(next) => updateItem(index, next)}
                locale={locale}
                sourceValue={
                  typeof sourceItems[index] === "string"
                    ? sourceItems[index]
                    : undefined
                }
                translate={translate}
                generate={generate}
                sliceType={sliceType}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function ensureKeyCount(keys: string[], count: number): string[] {
  if (keys.length === count) return keys
  if (keys.length > count) return keys.slice(0, count)
  return [
    ...keys,
    ...Array.from({ length: count - keys.length }, () => `itemId:${crypto.randomUUID()}`),
  ]
}
