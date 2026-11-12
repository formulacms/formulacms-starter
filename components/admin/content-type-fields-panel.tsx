"use client"

import { adminFieldMetadata } from "@/lib/i18n/admin-metadata"

import { Check, Pin, Star } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  FieldsEditor,
  FieldLocaleActions,
  type FieldGenerate,
  type FieldTranslate,
} from "./fields/field-editor"
import type { Primitive } from "@/convex/lib/slices"
import type { AdminContentType } from "@/lib/admin/content-types"
import {
  adminContentTypeLocalizedFields,
  adminContentTypeSharedFields,
} from "@/lib/admin/content-types"
import type { DescriptorFieldMap } from "@/convex/lib/contentTypes"
import {
  SYSTEM_OWNED_LOCALIZED_FIELDS,
  SYSTEM_OWNED_SHARED_FIELDS,
  filterOwnedFields,
} from "./page-editor/lib/system-owned-fields"

const LOCALIZED_FIELDS_HEADING_ID = "content-type-localized-heading"

/**
 * Descriptor-generic Content panel (plan 029 C8).
 *
 * Renders the two sections the plan §Recommended editor seam describes:
 *
 *   1. **All locales** — descriptor `sharedFields`, minus keys already
 *      surfaced by a system panel (e.g. `post.tags` via Internal Labels).
 *   2. **Active locale** — descriptor `localizedFields`, minus keys
 *      already owned by a system panel (title/metaTitle/metaDescription).
 *
 * The **All locales** section is rendered as a compact single-row chip
 * toolbar (2026-07-17 density redesign, prototype variant C): short text
 * fields become inline chips and booleans become toggle-pills, so a handful
 * of classification/flag fields no longer eat a tall stack of double-labelled
 * checkbox rows before the slice body. It is a presentation-only change — the
 * chip still carries the field's AI Write/Refine/Translate affordances, and
 * any field that isn't a short-text or a plain boolean (rich text, image,
 * list, relation, multiline text, a boolean carrying a `description`) falls
 * back to the full-width {@link FieldsEditor} widget below the toolbar, so no
 * capability is dropped. The per-language section keeps the full stacked form
 * — its fields (meta, prose) don't belong in tiny chips.
 *
 * The slice zone is composed by the host (page-editor `content-panel.tsx`)
 * and appears below this panel when `descriptor.capabilities.sliceBody`
 * is true — this component is deliberately slice-agnostic so the pure-form
 * path used by C10's non-slice descriptors (testimonial, faq-item) drops
 * cleanly out of the same seam.
 *
 * Two callers wire the same `sharedFieldValues` / `localizedFieldValues`
 * bags into `use-page-save`'s snapshot + recovery draft (Phase 3), so a
 * descriptor field edit trips the "Unsaved" indicator and survives a
 * refresh crash.
 *
 * `descriptorOverride` exists solely for component tests — production
 * callers pass `contentType` and the panel reads from the admin facade.
 * Tests pass `descriptorOverride` with a mock `sliceBody:false` capability
 * to exercise the pure-form assertion the plan calls out (no shipped
 * descriptor has `sliceBody:false` today).
 */
export type ContentTypeFieldsPanelProps = {
  contentType: AdminContentType
  sharedValues: Record<string, unknown>
  localizedValues: Record<string, unknown>
  onSharedChange(next: Record<string, unknown>): void
  onLocalizedChange(next: Record<string, unknown>): void
  currentLocale: string
  /** Source-locale shared/localized bags, for per-field AI translate pulls. */
  sourceSharedValues?: Record<string, unknown>
  sourceLocalizedValues?: Record<string, unknown>
  translate?: FieldTranslate
  generate?: FieldGenerate
  /** RTL flag for content inputs; admin chrome stays LTR. Default `"ltr"`. */
  dir?: "ltr" | "rtl"
  /** Test-only descriptor injection; production callers omit this. */
  descriptorOverride?: {
    sharedFields: DescriptorFieldMap
    localizedFields: DescriptorFieldMap
  }
}

export function ContentTypeFieldsPanel({
  contentType,
  sharedValues,
  localizedValues,
  onSharedChange,
  onLocalizedChange,
  currentLocale,
  sourceSharedValues,
  sourceLocalizedValues,
  translate,
  generate,
  dir = "ltr",
  descriptorOverride,
}: ContentTypeFieldsPanelProps) {
  const t = useTranslations("editor.contentFields")
  const rawShared: DescriptorFieldMap =
    descriptorOverride?.sharedFields ??
    adminContentTypeSharedFields(contentType.type)
  const rawLocalized: DescriptorFieldMap =
    descriptorOverride?.localizedFields ??
    adminContentTypeLocalizedFields(contentType.type)
  const shared = filterOwnedFields(rawShared, SYSTEM_OWNED_SHARED_FIELDS)
  const localized = filterOwnedFields(
    rawLocalized,
    SYSTEM_OWNED_LOCALIZED_FIELDS
  )

  const hasShared = Object.keys(shared).length > 0
  const hasLocalized = Object.keys(localized).length > 0

  if (!hasShared && !hasLocalized) return null

  return (
    <div className="space-y-6">
      {hasShared && (
        <SharedFieldsToolbar
          fields={shared}
          values={sharedValues}
          onChange={onSharedChange}
          sourceValues={sourceSharedValues}
          translate={translate}
          generate={generate}
          locale={currentLocale}
        />
      )}

      {hasLocalized && (
        <section
          aria-labelledby={LOCALIZED_FIELDS_HEADING_ID}
          className="space-y-3"
        >
          <div>
            <h3
              id={LOCALIZED_FIELDS_HEADING_ID}
              className="text-sm font-medium"
            >
              {currentLocale.toUpperCase()}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t("localizedDescription")}
            </p>
          </div>
          <FieldsEditor
            fields={localized}
            value={localizedValues}
            onChange={onLocalizedChange}
            basePath={`localized.${currentLocale}`}
            locale={currentLocale}
            sourceValues={sourceLocalizedValues}
            translate={translate}
            generate={generate}
            dir={dir}
          />
        </section>
      )}
    </div>
  )
}

/**
 * The **All locales** shared-fields section as a compact chip toolbar.
 *
 * Splits the descriptor's shared fields into three lanes:
 * - plain booleans → {@link BooleanPill} (single-line toggle, no double label)
 * - single-line text → {@link TextFieldChip} (inline input + AI actions)
 * - everything else → full-width {@link FieldsEditor} below the toolbar
 *
 * Both the toolbar controls and the fallback editor write through the same
 * `onChange(fullBag)` contract by spreading the current `values`, so edits in
 * either lane never clobber the other's keys.
 */
function SharedFieldsToolbar({
  fields,
  values,
  onChange,
  sourceValues,
  translate,
  generate,
  locale,
}: {
  fields: DescriptorFieldMap
  values: Record<string, unknown>
  onChange(next: Record<string, unknown>): void
  sourceValues?: Record<string, unknown>
  translate?: FieldTranslate
  generate?: FieldGenerate
  locale: string
}) {
  const t = useTranslations("editor.contentFields")
  const tMetadata = useTranslations("metadata")
  const entries = Object.entries(fields) as [string, Primitive][]
  const chips = entries.filter(([, def]) => isTextChip(def))
  const pills = entries.filter(([, def]) => isBooleanPill(def))
  const rest = entries.filter(
    ([, def]) => !isTextChip(def) && !isBooleanPill(def)
  )
  const hasToolbar = chips.length + pills.length > 0
  const restFields = Object.fromEntries(rest) as DescriptorFieldMap

  const set = (key: string, value: unknown) =>
    onChange({ ...values, [key]: value })

  return (
    <section aria-label={t("allLocales")} className="space-y-3">
      {hasToolbar ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2">
          <span
            className="mr-1 text-xs font-medium text-muted-foreground"
            title={t("sharedDescription")}
          >
            {t("allLocales")}
          </span>
          {chips.map(([key, def]) => (
            <TextFieldChip
              key={key}
              label={adminFieldMetadata(def, key, tMetadata).label}
              def={adminFieldMetadata(def, key, tMetadata).def}
              value={values[key]}
              sourceValue={sourceValueFor(sourceValues, key)}
              translate={translate}
              generate={generate}
              onChange={(v) => set(key, v)}
            />
          ))}
          {pills.map(([key, def]) => (
            <BooleanPill
              key={key}
              fieldKey={key}
              label={adminFieldMetadata(def, key, tMetadata).label}
              def={adminFieldMetadata(def, key, tMetadata).def}
              value={values[key]}
              onChange={(v) => set(key, v)}
            />
          ))}
        </div>
      ) : (
        <div>
          <h3 className="text-sm font-medium">{t("allLocales")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("sharedDescription")}
          </p>
        </div>
      )}

      {rest.length > 0 && (
        <FieldsEditor
          fields={restFields}
          value={values}
          onChange={onChange}
          basePath="shared"
          locale={locale}
          sourceValues={sourceValues}
          translate={translate}
          generate={generate}
        />
      )}
    </section>
  )
}

/** Single-line text field as a toolbar chip, keeping its AI action row. */
function TextFieldChip({
  label,
  def,
  value,
  sourceValue,
  translate,
  generate,
  onChange,
}: {
  label: string
  def: Primitive
  value: unknown
  sourceValue?: string
  translate?: FieldTranslate
  generate?: FieldGenerate
  onChange(value: unknown): void
}) {
  const t = useTranslations("editor.contentFields")
  const cfg = def.config as { placeholder?: string; maxLength?: number }
  const str = (value as string) ?? ""
  const optional = isOptional(def)
  const set = (s: string) => onChange(optional ? s || undefined : s)
  return (
    <div className="inline-flex items-center gap-2 rounded-full border bg-background py-1 pr-2.5 pl-3 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <input
        type="text"
        value={str}
        onChange={(e) => set(e.target.value)}
        placeholder={cfg.placeholder ?? t("addPlaceholder")}
        maxLength={cfg.maxLength}
        aria-label={label}
        size={Math.max(6, str.length || 6)}
        className="min-w-20 rounded-full bg-transparent px-1.5 py-0.5 focus:ring-1 focus:ring-ring focus:outline-none"
      />
      <FieldLocaleActions
        label={label}
        sourceValue={sourceValue}
        currentValue={str}
        kind="text"
        translate={translate}
        generate={generate}
        onResult={set}
      />
    </div>
  )
}

/** Plain boolean as a single-line toggle-pill (filled = on). */
function BooleanPill({
  fieldKey,
  label,
  def,
  value,
  onChange,
}: {
  fieldKey: string
  label: string
  def: Primitive
  value: unknown
  onChange(value: boolean): void
}) {
  const cfg = def.config as { label?: string; default?: boolean }
  const checked = typeof value === "boolean" ? value : (cfg.default ?? false)
  const text = cfg.label ?? label
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors ${
        checked
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-background text-muted-foreground hover:text-foreground"
      }`}
    >
      <PillIcon fieldKey={fieldKey} filled={checked} />
      {text}
    </button>
  )
}

/** A boolean becomes a pill only when it carries no `description` — a described
 *  boolean keeps its full widget so the explanatory copy isn't lost. */
function isBooleanPill(def: Primitive): boolean {
  if (def.kind !== "boolean") return false
  return !(def.config as { description?: string }).description
}

/** Single-line text (not multiline) is chip-eligible. */
function isTextChip(def: Primitive): boolean {
  return (
    def.kind === "text" &&
    (def.config as { multiline?: boolean }).multiline !== true
  )
}

function isOptional(def: Primitive): boolean {
  return (def.validator as { isOptional?: string }).isOptional === "optional"
}

/** Decorative pill icon inferred from the field's intent; falls back to a
 *  check. aria-hidden — the pill's text label carries the meaning. `filled`
 *  applies only to the star/pin (a filled checkmark reads oddly). */
function PillIcon({ fieldKey, filled }: { fieldKey: string; filled: boolean }) {
  const k = fieldKey.toLowerCase()
  const className = `size-3.5 ${filled ? "fill-current" : ""}`
  if (k.includes("feature")) return <Star aria-hidden className={className} />
  if (
    k.includes("promote") ||
    k.includes("pin") ||
    k.includes("sticky") ||
    k.includes("front")
  )
    return <Pin aria-hidden className={className} />
  return <Check aria-hidden className="size-3.5" />
}

function sourceValueFor(
  bag: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const v = bag?.[key]
  return typeof v === "string" ? v : undefined
}
