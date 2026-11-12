import type { ReactElement, ReactNode } from "react"
import { createElement } from "react"
import type { GenericValidator, Infer } from "convex/values"
import type { Primitive } from "@/convex/lib/slices/primitives"
import { isPrimitiveValueEmpty } from "@/convex/lib/slices/primitives"
import type { ButtonField, ImageField } from "@/convex/lib/slices"
import type { ImageFrame } from "@/lib/media/image-presentation"
import type { RichTextProfile } from "@/convex/lib/richtext/profiles"
import {
  resolveFieldContract,
  type RichTextContractConfig,
  type FieldAddress,
} from "@/convex/lib/richtext/contracts"
import {
  convertTransitionTitle,
  transitionForField,
} from "@/convex/lib/richtext/transitions"
import { toFieldShape } from "@/convex/lib/richtext/shape"
import { richTextToDocument } from "@/lib/rich-text/render"
import { RichTextContent } from "@/components/slices/rich-text-content"
import { SliceButtons, SliceImage } from "@/components/slices/render-helpers"
import { parseFieldPath } from "./field-path"
import type { SliceRenderContext } from "@/lib/slices/links"
import {
  fieldHeadingLevel,
  isOutlineFieldVisible,
  validateOutlineDescriptor,
  type SliceFieldOutline,
  type OutlineField,
} from "@/lib/slices/page-outline"
export { HeadingSlot } from "./heading-slot"
export { Accordion, type AccordionRow } from "./accordion"

type StampProps = {
  "data-tweak-loc"?: string
  "data-tweak-source"?: string
  "data-tweak-path"?: string
}

export type SliceDescriptor = {
  type?: string
  primary: Primitive<
    GenericValidator,
    "group",
    { fields: Record<string, Primitive> }
  >
  items?: Primitive
}

type ConfigOf<P> =
  P extends Primitive<GenericValidator, string, infer C> ? C : never
type ChildrenOf<P> =
  ConfigOf<P> extends { fields: infer F extends Record<string, Primitive> }
    ? F
    : never
type ItemOf<P> =
  ConfigOf<P> extends { item: infer I extends Primitive } ? I : never

type AtPath<P, Prefix extends string, Wanted extends string> =
  P extends Primitive<GenericValidator, infer K, Record<string, unknown>>
    ? K extends "group"
      ? {
          [N in keyof ChildrenOf<P> & string]: AtPath<
            ChildrenOf<P>[N],
            `${Prefix}.${N}`,
            Wanted
          >
        }[keyof ChildrenOf<P> & string]
      : K extends "list"
        ? | (K extends Wanted ? Prefix : never)
          | AtPath<ItemOf<P>, `${Prefix}[${number}]`, Wanted>
        : K extends Wanted
          ? Prefix
          : never
    : never

export type SliceFieldPath<D, Kind extends string = string> = D extends {
  primary: infer P extends Primitive
  items?: infer I extends Primitive
}
  ? AtPath<P, "primary", Kind> | AtPath<I, "items", Kind>
  : D extends { primary: infer P extends Primitive }
    ? AtPath<P, "primary", Kind>
    : never

export type RichTextPath<D> = SliceFieldPath<D, "richText">
export type TextPath<D> = SliceFieldPath<D, "text">
export type ImagePath<D> = SliceFieldPath<D, "image">
type RichTextProfilePath<
  P,
  Prefix extends string,
  Profile extends RichTextProfile,
> =
  P extends Primitive<GenericValidator, infer K, Record<string, unknown>>
    ? K extends "group"
      ? {
          [N in keyof ChildrenOf<P> & string]: RichTextProfilePath<
            ChildrenOf<P>[N],
            `${Prefix}.${N}`,
            Profile
          >
        }[keyof ChildrenOf<P> & string]
      : K extends "list"
        ? RichTextProfilePath<ItemOf<P>, `${Prefix}[${number}]`, Profile>
        : K extends "richText"
          ? ConfigOf<P> extends { profile: Profile } | { contract: Profile }
            ? Prefix
            : never
          : never
    : never
type RichTextPathsFor<D, Profile extends RichTextProfile> = D extends {
  primary: infer P extends Primitive
  items?: infer I extends Primitive
}
  ? | RichTextProfilePath<P, "primary", Profile>
    | RichTextProfilePath<I, "items", Profile>
  : D extends { primary: infer P extends Primitive }
    ? RichTextProfilePath<P, "primary", Profile>
    : never
type InlineRichTextPath<D> = RichTextPathsFor<D, "inline">
type NonInlineRichTextPath<D> = Exclude<RichTextPath<D>, InlineRichTextPath<D>>
export type NonHeadingSemanticHost = Exclude<
  SemanticHost,
  `h${1 | 2 | 3 | 4 | 5 | 6}`
>
type ButtonPathsFor<P, Prefix extends string> = P extends {
  readonly kind: "group"
  readonly config: { fields: infer F extends Record<string, unknown> }
}
  ? {
      [N in keyof F & string]: ButtonPathsFor<F[N], `${Prefix}.${N}`>
    }[keyof F & string]
  : P extends {
        readonly kind: "list"
        readonly validator: infer V extends GenericValidator
      }
    ? Infer<V> extends ButtonField[]
      ? Prefix
      : never
    : never

type ButtonListPath<D> = D extends { primary: infer P }
  ? | ButtonPathsFor<P, "primary">
    | (D extends { items?: infer I }
        ? ButtonPathsFor<NonNullable<I>, "items">
        : never)
  : never

export type SemanticHost =
  "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p" | "span" | "div"

type ResolvedField = {
  descriptor: Primitive
  value: unknown
  fieldPath: string
}

export type BoundSliceFields<D extends SliceDescriptor, S> = {
  readonly descriptor: D
  readonly slice: S
  resolve(path: NoInfer<SliceFieldPath<D>>): ResolvedField | null
  isEmpty(path: NoInfer<SliceFieldPath<D>>): boolean
}

const forbidden = new Set(["__proto__", "constructor", "prototype"])
const STRICT_PATH =
  /^[A-Za-z_$][\w$]*(?:(?:\.[A-Za-z_$][\w$]*)|(?:\[(?:0|[1-9]\d*)\]))*$/

function parseStrictPath(path: string): string[] | null {
  if (!STRICT_PATH.test(path)) return null
  const parts = parseFieldPath(path)
  if (parts.length === 0 || parts.some((part) => !part || forbidden.has(part)))
    return null
  return parts
}

function descriptorAt(
  descriptor: SliceDescriptor,
  parts: string[]
): Primitive | null {
  const [root, ...tail] = parts
  let current: Primitive | undefined =
    root === "primary"
      ? descriptor.primary
      : root === "items"
        ? descriptor.items
        : undefined
  if (!current) return null
  for (const part of tail) {
    if (current.kind === "group") {
      const groupFields: Record<string, Primitive> | undefined = (
        current.config as { fields?: Record<string, Primitive> }
      ).fields
      current = groupFields?.[part]
    } else if (current.kind === "list") {
      if (!/^(0|[1-9]\d*)$/.test(part)) return null
      current = (current.config as { item?: Primitive }).item
    } else {
      return null
    }
    if (!current) return null
  }
  return current
}

function valueAt(slice: unknown, parts: string[]): unknown {
  let value = slice
  for (const part of parts) {
    if (value === null || typeof value !== "object") return undefined
    if (Array.isArray(value)) {
      const index = Number(part)
      if (!Number.isInteger(index) || index < 0 || index >= value.length)
        return undefined
      value = value[index]
    } else {
      value = (value as Record<string, unknown>)[part]
    }
  }
  return value
}

function pathHasPresentListRows(slice: unknown, parts: string[]): boolean {
  let value = slice
  for (const part of parts) {
    if (value === null || typeof value !== "object") return false
    if (Array.isArray(value)) {
      const index = Number(part)
      if (
        !/^(0|[1-9]\d*)$/.test(part) ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= value.length
      )
        return false
      value = value[index]
    } else {
      value = (value as Record<string, unknown>)[part]
    }
  }
  return true
}

function isKitFieldEmpty(
  field: Primitive,
  value: unknown,
  address?: FieldAddress
): boolean {
  if (field.kind === "richText") {
    if (typeof value !== "string") return true
    const resolved = resolveFieldContract(
      field.config as RichTextContractConfig
    )
    const profile = resolved.profile ?? "inline"
    // Reuse the renderer's profile validation and legacy sanitization so this
    // visibility test cannot disagree with the content that actually renders.
    const displayValue = kitDisplayValue(value, resolved, address)
    return profile === "inline"
      ? !isOutlineFieldVisible(displayValue)
      : !isOutlineFieldVisible(displayValue, { kind: "body", profile })
  }
  return isPrimitiveValueEmpty(field, value)
}

function kitDisplayValue(
  value: string,
  resolved: ReturnType<typeof resolveFieldContract>,
  address?: FieldAddress
): string {
  if (resolved.contract !== "title") return value
  const transitioned = convertTransitionTitle(address, value)
  if (transitioned) return transitioned.value
  // Use the existing tolerant reader and D1 shape adapter on a render-only copy.
  // This also strips legacy-HTML links from title content; nothing is persisted.
  const document = richTextToDocument(value, "inline")
  return toFieldShape(resolved, JSON.stringify(document)).value
}

function kitFieldOutline<D extends SliceDescriptor>(
  fields: BoundSliceFields<D, unknown>,
  ctx?: SliceRenderContext
): SliceFieldOutline | undefined {
  const declared: Record<string, OutlineField> = {}
  function walk(field: Primitive, path: string) {
    const config = field.config as Record<string, unknown>
    if (field.kind === "group") {
      for (const [name, child] of Object.entries(
        config.fields as Record<string, Primitive>
      ))
        walk(child, `${path}.${name}`)
    } else if (field.kind === "list") {
      walk(config.item as Primitive, path)
    } else if (field.kind === "richText") {
      const contract = resolveFieldContract(config as RichTextContractConfig)
      if (contract.contract === "title")
        declared[path] = {
          parent: contract.parent,
          ...(fields.descriptor.type &&
          transitionForField({
            sliceType: fields.descriptor.type,
            fieldPath: path,
          })
            ? { kind: "text" as const }
            : {}),
        }
      else if (contract.headingFloorParent)
        declared[path] = { parent: contract.headingFloorParent, kind: "body" }
    }
  }
  walk(fields.descriptor.primary, "primary")
  if (fields.descriptor.items) walk(fields.descriptor.items, "items")
  if (!ctx?.outline && !Object.keys(declared).length) return undefined
  const errors = validateOutlineDescriptor({
    canOpenPage: false,
    fields: { ...ctx?.outline?.fields, ...declared },
  })
  if (errors.length) throw new Error(errors.join("; "))
  return {
    base: ctx?.outline?.base ?? 2,
    slice: fields.slice,
    fields: { ...ctx?.outline?.fields, ...declared },
  }
}

/** Bind a slice instance to its descriptor. This is pure and carries no render context. */
export function bindSliceFields<D extends SliceDescriptor, S>(
  descriptor: D,
  slice: S
): BoundSliceFields<D, S> {
  const resolve = (path: SliceFieldPath<D>): ResolvedField | null => {
    const parts = parseStrictPath(path)
    if (!parts || !pathHasPresentListRows(slice, parts)) return null
    const field = descriptorAt(descriptor, parts)
    if (!field) return null
    return {
      descriptor: field,
      value: valueAt(slice, parts),
      fieldPath: parts.join("."),
    }
  }
  return {
    descriptor,
    slice,
    resolve,
    isEmpty(path) {
      const field = resolve(path)
      return (
        !field ||
        isKitFieldEmpty(
          field.descriptor,
          field.value,
          descriptor.type
            ? { sliceType: descriptor.type, fieldPath: field.fieldPath }
            : undefined
        )
      )
    },
  }
}

function previewField(
  ctx: SliceRenderContext | undefined,
  field: ResolvedField,
  rendered: ReactNode
): ReactNode {
  return ctx?.previewField
    ? ctx.previewField({
        fieldPath: field.fieldPath,
        kind: field.descriptor.kind,
        rendered,
      })
    : rendered
}

export function RichText<D extends SliceDescriptor>({
  fields,
  fieldPath,
  as,
  ctx,
  className,
  id,
  host = "native",
  headingLevel,
  ...stampProps
}: (
  | {
      fields: BoundSliceFields<D, unknown>
      fieldPath: NoInfer<InlineRichTextPath<D>>
      headingLevel?: number
      as?: SemanticHost
      ctx?: SliceRenderContext
      className?: string
      id?: string
    }
  | {
      fields: BoundSliceFields<D, unknown>
      fieldPath: NoInfer<NonInlineRichTextPath<D>>
      headingLevel?: never
      as?: NonHeadingSemanticHost
      ctx?: SliceRenderContext
      className?: string
      id?: string
    }
) &
  StampProps & {
    host?: "native" | "inline"
  }): ReactElement | null {
  const path = fieldPath as SliceFieldPath<D>
  const field = fields.resolve(path)
  if (!field || fields.isEmpty(path)) return null
  const resolved = resolveFieldContract(
    field.descriptor.config as RichTextContractConfig
  )
  const outline = kitFieldOutline(fields, ctx)
  const profile = resolved.profile ?? "inline"
  const semanticHost =
    resolved.contract === "title"
      ? host === "inline"
        ? "span"
        : `h${outline ? fieldHeadingLevel(outline, field.fieldPath) : resolved.headingDefaultLevel}`
      : headingLevel
        ? `h${headingLevel}`
        : (as ?? (profile === "inline" ? "span" : "div"))
  // The kit owns the semantic host and therefore intercepts it once. Keep
  // link/media context for rendered rich text while avoiding the legacy
  // RichTextContent interception that would stamp its inner host as well.
  const innerContext =
    ctx || outline
      ? {
          ...ctx,
          locale: ctx?.locale ?? "en",
          defaultLocale: ctx?.defaultLocale ?? "en",
          pagePaths: ctx?.pagePaths ?? {},
          outline,
          previewRichText: undefined,
        }
      : undefined
  const inner = (
    <RichTextContent
      value={kitDisplayValue(
        field.value as string,
        resolved,
        fields.descriptor.type
          ? { sliceType: fields.descriptor.type, fieldPath: field.fieldPath }
          : undefined
      )}
      profile={profile}
      ctx={innerContext}
      fieldPath={field.fieldPath}
    />
  )
  const rendered = createElement(
    semanticHost,
    { className, id, ...stampProps },
    inner
  )
  if (ctx?.previewRichText) {
    return ctx.previewRichText({
      fieldPath: field.fieldPath,
      value: field.value as string,
      profile,
      contract: resolved.contract,
      headingFloor:
        profile !== "inline" && outline
          ? fieldHeadingLevel(outline, field.fieldPath)
          : undefined,
      className: className ?? "",
      rendered,
    }) as ReactElement
  }
  return previewField(ctx, field, rendered) as ReactElement
}

export function Text<D extends SliceDescriptor>({
  fields,
  fieldPath,
  as = "span",
  ctx,
  className,
  ...stampProps
}: {
  fields: BoundSliceFields<D, unknown>
  fieldPath: NoInfer<TextPath<D>>
  as?: NonHeadingSemanticHost
  ctx?: SliceRenderContext
  className?: string
} & StampProps): ReactElement | null {
  const path = fieldPath as SliceFieldPath<D>
  const field = fields.resolve(path)
  if (!field || fields.isEmpty(path)) return null
  const rendered = createElement(
    as,
    { className, ...stampProps },
    String(field.value ?? "")
  )
  return previewField(ctx, field, rendered) as ReactElement
}

export function Buttons<D extends SliceDescriptor>({
  fields,
  fieldPath,
  ctx,
  className,
  onBrand,
}: {
  fields: BoundSliceFields<D, unknown>
  fieldPath: NoInfer<ButtonListPath<D>>
  ctx: SliceRenderContext
  className?: string
  onBrand?: boolean
}): ReactElement | null {
  const path = fieldPath as SliceFieldPath<D>
  const field = fields.resolve(path)
  if (!field || fields.isEmpty(path)) return null
  return (
    <SliceButtons
      items={field.value as ButtonField[]}
      ctx={ctx}
      className={className}
      onBrand={onBrand}
      fieldPath={field.fieldPath}
    />
  )
}

export function KitImage<D extends SliceDescriptor>({
  fields,
  fieldPath,
  ctx,
  className,
  altFallback,
  decorative = false,
  priority = false,
  sizes,
  fill = false,
  frame = "aspect",
  bleed = false,
}: {
  fields: BoundSliceFields<D, unknown>
  fieldPath: NoInfer<ImagePath<D>>
  ctx?: SliceRenderContext
  className?: string
  altFallback?: string
  decorative?: boolean
  priority?: boolean
  sizes?: string
  fill?: boolean
  frame?: ImageFrame
  bleed?: boolean
}): ReactElement | null {
  const path = fieldPath as SliceFieldPath<D>
  const field = fields.resolve(path)
  if (!field || fields.isEmpty(path)) return null
  return (
    <SliceImage
      image={field.value as ImageField}
      className={className}
      altFallback={altFallback}
      decorative={decorative}
      priority={priority}
      sizes={sizes}
      fill={fill}
      frame={frame}
      bleed={bleed}
      fieldPath={field.fieldPath}
      ctx={ctx}
    />
  )
}
