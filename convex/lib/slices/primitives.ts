import {
  v,
  type Infer,
  type GenericValidator,
  type VOptional,
  type VObject,
  type VString,
} from "convex/values"
import type { PageType } from "../pages/types"
import { isRichTextEmpty } from "../richtext/emptiness"
import type { RichTextContractConfig } from "../richtext/contracts"
import { resolveFieldContract } from "../richtext/contracts"

/**
 * Field-primitive registry — convex-side half (ADR-0008).
 *
 * Each leaf factory returns a {@link Primitive} descriptor that is the single
 * source of truth for a field's Convex validator + canonical default. Slices
 * declare their fields by referencing primitives instead of hand-coding a
 * validator. The editor/renderer halves (keyed by `kind`) live app-side and
 * land in Phase C.
 *
 * Canonical shape (ADR-0008): every field has a schema-valid default. "Unset"
 * is expressed by a neutral value (empty string/list, placeholder image, etc.)
 * even when the field is `.optional()`; optionality widens accepted persisted
 * data but does not remove the editor/sample default.
 *
 * The generics keep `Infer<typeof sliceValidator>` precise — no `v.any()`
 * (ADR-003). Runtime construction uses one contained cast in `group`; the
 * public `validator` type stays exact.
 */

/** An empty ProseMirror document, serialized. rich-text stores PM-JSON as a
 *  string (ADR-0009); profile enforcement + HTML→PM-JSON migration are Phase B/D. */
export const EMPTY_PM_DOC = '{"type":"doc","content":[]}'
export const PLACEHOLDER_IMAGE_URL = "/slice-placeholders/placeholder.png"

export interface Primitive<
  V extends GenericValidator = GenericValidator,
  K extends string = string,
  C extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly kind: K
  readonly config: C
  readonly validator: V
  /** Canonical default value for editor/sample/generated slices. */
  readonly default: Infer<V> | undefined
  /** Make this field optional: validator → `v.optional`, default is preserved. */
  optional(): Primitive<VOptional<V>, K, C>
  /**
   * Opt this field IN to public surfaces (renderer, search index, JSON-LD,
   * reference cards, exports). Default is admin-only (fail-closed) — ADR-0038.
   * Read by `isDescriptorFieldPublic()` in `convex/lib/contentTypes/exposure.ts`.
   * Consumers check the marker at top-level descriptor field iteration;
   * nested primitives inherit their container's classification (ADR-0038 §3).
   */
  public(): Primitive<V, K, C & { public: true }>
}

function makePrimitive<
  V extends GenericValidator,
  K extends string,
  C extends Record<string, unknown>,
>(
  kind: K,
  config: C,
  validator: V,
  defaultValue: Infer<V> | undefined
): Primitive<V, K, C> {
  return {
    kind,
    config,
    validator,
    default: defaultValue,
    optional() {
      const opt = v.optional(validator)
      return makePrimitive<VOptional<V>, K, C>(
        kind,
        { ...config },
        opt,
        defaultValue as Infer<typeof opt>
      )
    },
    public() {
      return makePrimitive<V, K, C & { public: true }>(
        kind,
        { ...config, public: true },
        validator,
        defaultValue
      )
    },
  }
}

/**
 * Semantic emptiness check for a stored primitive value (plan 029 C9a).
 *
 * Pure and client-safe: no ctx, no Convex imports, no async — the publish
 * checklist calls this server-side and the editor's live checklist projection
 * calls it client-side against unsaved editor state (`localizedFieldValues` /
 * `sharedFieldValues`). Both must agree on what "empty" means.
 *
 * Emptiness is per-kind:
 * - `text` / `date` / `datetime`: whitespace-only or missing is empty.
 * - `richText`: missing, whitespace, {@link EMPTY_PM_DOC}, or a doc whose
 *   `content` array is empty is empty. Parse failures fall through as
 *   non-empty (matches the checklist's original lenient stance).
 * - `image`: neither a real `storageId` nor a non-placeholder `url` is empty.
 * - `relation` / `link`: no target `pageId` / `mediaId` / `url` / `anchor`.
 * - `list`: an empty array is empty; a non-empty array is non-empty even if
 *   its rows would themselves recurse to empty (matches "did the editor add
 *   at least one row" intuition).
 * - `group`: empty when every child field is empty.
 * - Everything else (boolean, select, number, geopoint, embed, table):
 *   presence-only — `undefined`/`null` is empty.
 */
export function isPrimitiveValueEmpty(def: Primitive, value: unknown): boolean {
  if (value === undefined || value === null) return true
  switch (def.kind) {
    case "text":
    case "date":
    case "datetime":
      return typeof value !== "string" || value.trim().length === 0
    case "richText": {
      return isRichTextEmpty(value)
    }
    case "image": {
      if (typeof value !== "object") return true
      const image = value as { storageId?: string; url?: string }
      return (
        image.storageId === undefined &&
        (!image.url || image.url === PLACEHOLDER_IMAGE_URL)
      )
    }
    case "relation": {
      if (typeof value !== "object") return true
      const rel = value as { pageId?: unknown }
      return rel.pageId === undefined || rel.pageId === null
    }
    case "link": {
      if (typeof value !== "object") return true
      const link = value as {
        type?: string
        pageId?: unknown
        mediaId?: unknown
        url?: string
        anchor?: string
      }
      if (!link.type || link.type === "none") return true
      if (link.type === "internal") return !link.pageId
      if (link.type === "external") return !link.url
      if (link.type === "anchor") return !link.anchor
      if (link.type === "media") return !link.mediaId
      return false
    }
    case "list": {
      return !Array.isArray(value) || value.length === 0
    }
    case "group": {
      if (typeof value !== "object" || Array.isArray(value)) return true
      const fields =
        (def.config as { fields?: Record<string, Primitive> }).fields ?? {}
      const bag = value as Record<string, unknown>
      return Object.entries(fields).every(([key, child]) =>
        isPrimitiveValueEmpty(child, bag[key])
      )
    }
    default:
      return false
  }
}

// ============================================================
// Leaf primitives (the frozen v0.1 catalog of seven)
// ============================================================

export function text(
  config: {
    multiline?: boolean
    maxLength?: number
    placeholder?: string
    /** False for stored text that is identity/structure, not editor-authored copy. */
    editorial?: boolean
    /**
     * False for editor-authored text that is an identifier, not copy (an icon
     * name, an e-mail address): it is written and shown as is, but never sent
     * for translation and never shown in a translation review.
     */
    translatable?: boolean
  } = {}
) {
  return makePrimitive("text", config, v.string(), "")
}

/** Whether a text-like primitive is editor-authored copy rather than metadata. */
export function isEditorialTextPrimitive(def: Primitive): boolean {
  return (
    (def.kind === "text" || def.kind === "richText") &&
    def.config.editorial !== false
  )
}

/** Whether a text primitive is copy that a translation may change. */
export function isTranslatableTextPrimitive(def: Primitive): boolean {
  return (
    def.kind === "text" &&
    isEditorialTextPrimitive(def) &&
    def.config.translatable !== false
  )
}

export function richText<
  const C extends RichTextContractConfig & {
    placeholder?: string
  },
>(config: C) {
  const resolved = resolveFieldContract(config)
  const defaultValue =
    resolved.contract === "title"
      ? JSON.stringify({
          type: "doc",
          content: [
            { type: "heading", attrs: { level: resolved.headingDefaultLevel } },
          ],
        })
      : JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] })
  return makePrimitive(
    "richText",
    { ...config, contract: resolved.contract },
    v.string(),
    defaultValue
  )
}

export function image() {
  // Asset reference plus contextual accessibility/manipulation metadata. Crop
  // and focal point are per page/slice usage because the right framing depends
  // on the surrounding content.
  const validator = v.object({
    storageId: v.optional(v.id("_storage")),
    url: v.optional(v.string()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    alt: v.optional(v.string()),
    focal: v.optional(v.object({ x: v.number(), y: v.number() })),
    crop: v.optional(
      v.object({
        x: v.number(),
        y: v.number(),
        width: v.number(),
        height: v.number(),
      })
    ),
    cropSize: v.optional(
      v.object({
        width: v.number(),
        height: v.number(),
      })
    ),
  })
  return makePrimitive("image", {}, validator, {
    url: PLACEHOLDER_IMAGE_URL,
    width: 1200,
    height: 800,
    alt: "",
  })
}

export function link() {
  // A pure target (no label). Lenient write-path: a missing target renders as
  // a skip, matching today's behavior. `openInNewTab` implies
  // `rel="noopener noreferrer"`; the SEO/trust flags are additive and compose
  // in `composeRel` (lib/slices/links.ts).
  const validator = v.object({
    type: v.union(
      v.literal("internal"),
      v.literal("external"),
      v.literal("anchor"),
      v.literal("media"),
      v.literal("none")
    ),
    pageId: v.optional(v.id("pages")),
    mediaId: v.optional(v.id("media")),
    storageId: v.optional(v.id("_storage")),
    url: v.optional(v.string()),
    anchor: v.optional(v.string()),
    openInNewTab: v.optional(v.boolean()),
    noFollow: v.optional(v.boolean()),
    sponsored: v.optional(v.boolean()),
    ugc: v.optional(v.boolean()),
  })
  return makePrimitive("link", {}, validator, { type: "none" as const })
}

export function relation(config: {
  pageTypes: readonly [PageType, ...PageType[]]
  tag?: string
}) {
  // A data join to another page, not a href. The scaffolder's `ref` kind is a
  // shared descriptor reference (currently `button`); this stored primitive is
  // deliberately separate from both `ref` and `link`.
  const validator = v.object({
    pageId: v.optional(v.id("pages")),
  })
  return makePrimitive("relation", config, validator, {})
}

export function boolean(config: {
  label?: string
  description?: string
  default: boolean
}) {
  return makePrimitive("boolean", config, v.boolean(), config.default)
}

export function select<const T extends string>(config: {
  options: readonly [T, T, ...T[]]
  default: NoInfer<T>
  /** Optional display names per option, for values that don't humanize (e.g.
   *  `sm` → "Small"). The editor falls back to humanizing the raw value. */
  labels?: Partial<Record<T, string>>
}) {
  const validator = v.union(...config.options.map((o) => v.literal(o)))
  return makePrimitive("select", config, validator, config.default as T)
}

export function number(config: {
  min?: number
  max?: number
  step?: number
  default: number
}) {
  return makePrimitive("number", config, v.number(), config.default)
}

export function date(config: { placeholder?: string } = {}) {
  return makePrimitive("date", config, v.string(), "")
}

export function datetime(config: { placeholder?: string } = {}) {
  return makePrimitive("datetime", config, v.string(), "")
}

export function geopoint() {
  const validator = v.object({
    lat: v.number(),
    lng: v.number(),
  })
  return makePrimitive("geopoint", {}, validator, { lat: 0, lng: 0 })
}

export function embed(config: { placeholder?: string } = {}) {
  const validator = v.object({
    url: v.string(),
    provider: v.optional(v.string()),
    title: v.optional(v.string()),
  })
  return makePrimitive("embed", config, validator, { url: "" })
}

export function table(
  config: { minColumns?: number; maxColumns?: number } = {}
) {
  const validator = v.object({
    headerRow: v.optional(v.array(v.string())),
    rows: v.array(v.array(v.string())),
  })
  return makePrimitive("table", config, validator, { rows: [] })
}

// ============================================================
// Combinators
// ============================================================

/** A named object of fields (primitives or nested groups). */
export function group<F extends Record<string, Primitive>>(fields: F) {
  // One contained cast: map each field descriptor to its validator. The mapped
  // *type* stays precise, so v.object's Infer is exact (no `v.any()`).
  const validators = Object.fromEntries(
    Object.entries(fields).map(([k, def]) => [k, def.validator])
  ) as { [K in keyof F]: F[K]["validator"] }
  const validator = v.object(validators)

  const defaults: Record<string, unknown> = {}
  for (const key of Object.keys(fields)) {
    const d = fields[key].default
    if (d !== undefined) defaults[key] = d
  }
  return makePrimitive(
    "group",
    { fields },
    validator,
    defaults as Infer<typeof validator>
  )
}

/** A bounded, repeatable sequence of a single primitive or group. */
type ListRowValidator<V extends GenericValidator> =
  V extends VObject<infer Type, infer Fields>
    ? VObject<
        Type & { itemId?: string },
        Fields & { itemId: VOptional<VString> }
      >
    : V

export function list<P extends Primitive>(
  item: P,
  opts: { min?: number; max?: number } = {}
) {
  const rowValidator = (
    item.validator.kind === "object"
      ? (
          item.validator as VObject<
            Record<string, unknown>,
            Record<string, GenericValidator>
          >
        ).extend({ itemId: v.optional(v.string()) })
      : item.validator
  ) as ListRowValidator<P["validator"]>
  // Keep the concrete row validator and original config.item type: the kit
  // derives field paths from them. Only object rows gain optional itemId.
  const validator = v.array<ListRowValidator<P["validator"]>>(rowValidator)
  return makePrimitive("list", { item, ...opts }, validator, [])
}
