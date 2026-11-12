import { readSliceDefinition } from "@/convex/lib/slices"
import { readSlice } from "@/convex/lib/slices/identity"
import { ConvexError, v, type Infer } from "convex/values"
import type { Doc, Id } from "../../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../../_generated/server"
import { contentTypeDefs, type ContentType } from "../contentTypes"
import { hasSliceBody } from "../pages/sliceBodyContent"
import { type Slice } from "../slices"
import { walkFieldMap, walkValue } from "../slices/walk"
import {
  isPrimitiveValueEmpty,
  PLACEHOLDER_IMAGE_URL,
  type Primitive,
} from "../slices/primitives"
import { isRichTextEmpty } from "../richtext/emptiness"
import {
  createPublicSnapshotProjectionReader,
  readPublicationAuthority,
} from "./snapshots"

/**
 * Publishing pipeline: pre-publish checklist (plan 028 C0).
 *
 * Enforces the "publish blocker" gate — required slice fields, image alt text,
 * SEO metadata, and target-page validity — and produces the warning/blocker
 * lists surfaced by the editor and archived into revision metadata.
 */

export const prePublishChecklistCodeValidator = v.union(
  v.literal("missing_default_locale_title"),
  v.literal("missing_default_locale_content"),
  v.literal("missing_seo_title"),
  v.literal("missing_seo_description"),
  v.literal("missing_enabled_locale_translation"),
  v.literal("missing_required_slice_field"),
  // Plan 029 C9a — publish blocker/warning for a required descriptor
  // shared/localized field with a semantically empty value. Historical
  // slice-side code stays for revision-archive back-compat (ADR-0029).
  v.literal("missing_required_field"),
  v.literal("missing_image_alt_text"),
  v.literal("broken_internal_link"),
  v.literal("archived_relation_target")
)

export const prePublishChecklistParamsValidator = v.object({
  variant: v.optional(
    v.union(
      v.literal("body"),
      v.literal("image"),
      v.literal("relation"),
      v.literal("missing_link_target"),
      v.literal("disallowed_type")
    )
  ),
  contentType: v.optional(v.string()),
  sliceType: v.optional(v.string()),
  fieldName: v.optional(v.string()),
  targetTitle: v.optional(v.string()),
  localeSpecific: v.optional(v.boolean()),
})

export const prePublishChecklistItemValidator = v.object({
  code: prePublishChecklistCodeValidator,
  severity: v.union(v.literal("blocker"), v.literal("warning")),
  message: v.string(),
  // Live translation inputs only. Revision snapshots retain the original
  // message and compact fields below (ADR-0029), without a migration.
  params: v.optional(prePublishChecklistParamsValidator),
  field: v.optional(v.string()),
  locales: v.optional(v.array(v.string())),
})

export const prePublishChecklistValidator = v.object({
  pageId: v.id("pages"),
  defaultLocale: v.string(),
  enabledLocales: v.array(v.string()),
  canPublish: v.boolean(),
  blockers: v.array(prePublishChecklistItemValidator),
  warnings: v.array(prePublishChecklistItemValidator),
})

export type PrePublishChecklistParams = Infer<
  typeof prePublishChecklistParamsValidator
>

export type PrePublishChecklistItem = {
  code:
    | "missing_default_locale_title"
    | "missing_default_locale_content"
    | "missing_seo_title"
    | "missing_seo_description"
    | "missing_enabled_locale_translation"
    | "missing_required_slice_field"
    | "missing_required_field"
    | "missing_image_alt_text"
    | "broken_internal_link"
    | "archived_relation_target"
  severity: "blocker" | "warning"
  message: string
  params?: PrePublishChecklistParams
  field?: string
  locales?: string[]
}

export type PrePublishChecklist = {
  pageId: Id<"pages">
  defaultLocale: string
  enabledLocales: string[]
  canPublish: boolean
  blockers: PrePublishChecklistItem[]
  warnings: PrePublishChecklistItem[]
}

/**
 * The archived form of a pre-publish checklist embedded in
 * `pageRevisions.metadata.checklist`. `code` is the same closed union as the
 * live checklist — keeps the revisions archive strictly typed rather than
 * widening to bare `string` (which was the shape before extraction).
 */
export type PageRevisionChecklistSnapshot = {
  blockerCount: number
  warningCount: number
  blockers: Array<{
    code: PrePublishChecklistItem["code"]
    message: string
    field?: string
    locales?: string[]
  }>
  warnings: Array<{
    code: PrePublishChecklistItem["code"]
    message: string
    field?: string
    locales?: string[]
  }>
}

/** Minimal locale-config shape consumed by the checklist. */
export type ChecklistLocaleConfig = {
  defaultLocale: string
  enabledLocales: string[]
}

function isOptionalField(def: Primitive): boolean {
  return def.validator.isOptional === "optional"
}

/**
 * Localized descriptor fields already covered by the core checklist
 * (`missing_default_locale_title`, `missing_seo_title`/`_description`).
 * The descriptor walk skips them so an empty required title doesn't
 * emit two blockers for one field — and so non-default-locale title/meta
 * missing stays a `missing_enabled_locale_translation` warning instead
 * of a stricter `missing_required_field` blocker (plan 029 §Standing
 * invariants, N-locale policy).
 *
 * Kept as a checklist-local set rather than importing the client-side
 * `SYSTEM_OWNED_LOCALIZED_FIELDS` — the server can't import from
 * `components/`, and the ownership axis here is subtly different
 * ("core-checked by dedicated logic"), not just "rendered by a system
 * panel".
 */
const CORE_CHECKED_LOCALIZED_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "metaTitle",
  "metaDescription",
])

function formatDescriptorField(
  fieldKey: string,
  leafPath: string,
  scope: "shared" | { locale: string }
): string {
  const absolute =
    leafPath.length > 0
      ? leafPath.startsWith("[")
        ? `${fieldKey}${leafPath}`
        : leafPath
      : fieldKey
  return scope === "shared" ? absolute : `content.${scope.locale}.${absolute}`
}

interface DescriptorRelationSpec {
  targetId: Id<"pages">
  allowedTypes: readonly string[]
  field: string
  locales?: string[]
  requiresPublicTarget: boolean
}

/**
 * Walk a descriptor's shared or localized field map and emit checklist
 * items for semantically-empty required primitives. Descriptor relation
 * targets go into a separate spec list so their allowed content types,
 * field metadata, and locale-specific public availability stay intact.
 *
 * `severity` is chosen by the caller (default-locale/shared → blocker,
 * secondary-locale → warning) so this walker stays policy-agnostic.
 */
function walkDescriptorFieldMapForChecklist(
  fields: Record<string, Primitive>,
  values: Record<string, unknown> | undefined,
  opts: {
    scope: "shared" | { locale: string }
    severity: "blocker" | "warning"
    requiresPublicTarget: boolean
    typeLabel: string
    contentType: string
    skipLocalizedCoreChecked?: boolean
  },
  out: PrePublishChecklistItem[],
  descriptorRelations: DescriptorRelationSpec[]
): void {
  const scopeLabel =
    opts.scope === "shared" ? "" : opts.scope.locale.toUpperCase() + " "
  walkFieldMap(fields, values, (leaf) => {
    if (
      opts.skipLocalizedCoreChecked &&
      opts.scope !== "shared" &&
      CORE_CHECKED_LOCALIZED_FIELDS.has(leaf.fieldKey)
    ) {
      return
    }
    const required = !isOptionalField(leaf.def)
    const field = formatDescriptorField(leaf.fieldKey, leaf.path, opts.scope)

    if (required && isPrimitiveValueEmpty(leaf.def, leaf.value)) {
      out.push({
        code: "missing_required_field",
        severity: opts.severity,
        message: `${scopeLabel}${opts.typeLabel} is missing required ${leaf.path || leaf.fieldKey}.`,
        params: {
          contentType: opts.contentType,
          fieldName: leaf.path || leaf.fieldKey,
        },
        field,
        locales: opts.scope === "shared" ? undefined : [opts.scope.locale],
      })
      return
    }

    if (
      leaf.def.kind === "image" &&
      leaf.value &&
      typeof leaf.value === "object"
    ) {
      const image = leaf.value as {
        storageId?: string
        url?: string
        alt?: string
      }
      const hasRealImage =
        image.storageId !== undefined ||
        (!!image.url && image.url !== PLACEHOLDER_IMAGE_URL)
      if (hasRealImage && !image.alt?.trim()) {
        out.push({
          code: "missing_image_alt_text",
          severity: opts.severity,
          message: `${scopeLabel}${opts.typeLabel} image is missing alt text.`,
          params: { contentType: opts.contentType },
          field,
          locales: opts.scope === "shared" ? undefined : [opts.scope.locale],
        })
      }
    }

    if (
      leaf.def.kind === "relation" &&
      leaf.value &&
      typeof leaf.value === "object"
    ) {
      const relation = leaf.value as { pageId?: Id<"pages"> }
      if (relation.pageId) {
        // Descriptor relations stay separate from slice references so field
        // metadata and the allowed content-type contract survive the walk.
        // (Advisor-flagged post-C9a bug: a draft-author byline once surfaced
        // as a slice reference.)
        const allowedTypes =
          (leaf.def.config as { pageTypes?: readonly string[] }).pageTypes ?? []
        descriptorRelations.push({
          targetId: relation.pageId,
          allowedTypes,
          field,
          locales: opts.scope === "shared" ? undefined : [opts.scope.locale],
          requiresPublicTarget: opts.requiresPublicTarget,
        })
      }
    }
  })
}

function formatSliceField(locale: string, slice: Slice, path: string): string {
  return `content.${locale}.slices.${readSlice(slice).type}.${path}`
}

function inspectSliceForChecklist(
  slice: Slice,
  locale: string,
  blockers: PrePublishChecklistItem[],
  referencedPageLocales: Map<Id<"pages">, Set<string>>
): void {
  const addReference = (pageId: Id<"pages">) => {
    const locales = referencedPageLocales.get(pageId) ?? new Set<string>()
    locales.add(locale)
    referencedPageLocales.set(pageId, locales)
  }
  const def = readSliceDefinition(readSlice(slice).type)
  if (!def) return
  const inspectValue = (
    root: Primitive | undefined,
    value: unknown,
    rootPath: "primary" | "items"
  ) => {
    if (!root) return
    walkValue(root, value, ({ def, value, path }) => {
      const field = formatSliceField(
        locale,
        slice,
        path ? `${rootPath}.${path}` : rootPath
      )
      const required = !isOptionalField(def)

      if (required) {
        if (
          (def.kind === "text" && typeof value === "string" && !value.trim()) ||
          (def.kind === "richText" && isRichTextEmpty(value))
        ) {
          blockers.push({
            code: "missing_required_slice_field",
            severity: "blocker",
            message: `${locale.toUpperCase()} ${readSlice(slice).type} is missing required ${path || rootPath}.`,
            params: {
              sliceType: readSlice(slice).type,
              fieldName: path || rootPath,
            },
            field,
            locales: [locale],
          })
        }
        if (
          def.kind === "image" &&
          (!value ||
            typeof value !== "object" ||
            (!("storageId" in value) &&
              (!(value as { url?: string }).url ||
                (value as { url?: string }).url === PLACEHOLDER_IMAGE_URL)))
        ) {
          blockers.push({
            code: "missing_required_slice_field",
            severity: "blocker",
            message: `${locale.toUpperCase()} ${readSlice(slice).type} is missing a required image.`,
            params: { variant: "image", sliceType: readSlice(slice).type },
            field,
            locales: [locale],
          })
        }
      }

      if (def.kind === "image" && value && typeof value === "object") {
        const image = value as {
          storageId?: string
          url?: string
          alt?: string
        }
        const hasRealImage =
          image.storageId !== undefined ||
          (!!image.url && image.url !== PLACEHOLDER_IMAGE_URL)
        if (hasRealImage && !image.alt?.trim()) {
          blockers.push({
            code: "missing_image_alt_text",
            severity: "blocker",
            message: `${locale.toUpperCase()} ${readSlice(slice).type} image is missing alt text.`,
            params: { sliceType: readSlice(slice).type },
            field,
            locales: [locale],
          })
        }
      }

      if (def.kind === "link" && value && typeof value === "object") {
        const link = value as { type?: string; pageId?: Id<"pages"> }
        if (link.type === "internal") {
          if (link.pageId) {
            addReference(link.pageId)
          } else {
            blockers.push({
              code: "broken_internal_link",
              severity: "blocker",
              message: `${locale.toUpperCase()} ${readSlice(slice).type} has an internal link without a target page.`,
              params: {
                variant: "missing_link_target",
                sliceType: readSlice(slice).type,
              },
              field,
              locales: [locale],
            })
          }
        }
      }

      if (def.kind === "relation" && value && typeof value === "object") {
        const relation = value as { pageId?: Id<"pages"> }
        if (relation.pageId) {
          addReference(relation.pageId)
        } else if (required) {
          blockers.push({
            code: "missing_required_slice_field",
            severity: "blocker",
            message: `${locale.toUpperCase()} ${readSlice(slice).type} is missing a required related page.`,
            params: { variant: "relation", sliceType: readSlice(slice).type },
            field,
            locales: [locale],
          })
        }
      }
    })
  }

  inspectValue(def.primary, readSlice(slice).primary, "primary")
  if (def.items !== undefined && "items" in slice) {
    inspectValue(def.items, (slice as Record<string, unknown>).items, "items")
  }
}

function pickPageTitle(page: Doc<"pages">): string {
  const first = Object.values(page.content ?? {})[0]
  return first?.title || "Untitled"
}

function checklistTargetTitleParams(
  page: Doc<"pages">
): Pick<PrePublishChecklistParams, "targetTitle"> {
  const title = Object.values(page.content ?? {})[0]?.title
  // Leave untitled copy to the client dictionary; the archived message keeps
  // its original English fallback via pickPageTitle.
  return title ? { targetTitle: title } : {}
}

export function buildPrePublishChecklist(
  page: Doc<"pages">,
  cfg: ChecklistLocaleConfig
): PrePublishChecklist {
  const blockers: PrePublishChecklistItem[] = []
  const warnings: PrePublishChecklistItem[] = []
  const defaultContent = page.content?.[cfg.defaultLocale]

  if (!defaultContent?.title.trim()) {
    blockers.push({
      code: "missing_default_locale_title",
      severity: "blocker",
      message: `Add a title for the default locale (${cfg.defaultLocale.toUpperCase()}) before publishing.`,
      field: "content.title",
      locales: [cfg.defaultLocale],
    })
  }

  // Slice-body-specific checks — an empty slice canvas / missing SEO title
  // /description block only makes sense for a slice-bodied, routable arm.
  // Pure-form types (testimonial) have no slice canvas and no public URL —
  // per ADR-0038 §7 those checks are n/a for `sliceBody: false` arms.
  if (hasSliceBody(page)) {
    const sliceBodyContent = page.content?.[cfg.defaultLocale]
    // "Meaningful" = at least one enabled slice. A canvas full of disabled
    // slices renders nothing and is functionally identical to an empty
    // canvas, so it counts the same for publish-gating.
    const enabledSliceCount = (sliceBodyContent?.slices ?? []).filter(
      (slice) => readSlice(slice).enabled
    ).length
    const descriptor = contentTypeDefs[page.pageType as ContentType]
    const requiresBody = descriptor?.capabilities.requiresBodyContent === true

    if (enabledSliceCount === 0) {
      // Plan 029 C10 task 11 — `requiresBodyContent: true` promotes the
      // empty-canvas signal from a warning to a blocker. Types like
      // `post` set this because a post whose body is empty is a broken
      // publish, not a "you probably want to add copy" nudge. Types like
      // `landing-page` / `page` / `author` keep the softer warning (an
      // author profile page rendering only from slice cards is a
      // legitimate publish state).
      if (requiresBody) {
        blockers.push({
          code: "missing_required_field",
          severity: "blocker",
          message: `Add at least one enabled content section for ${cfg.defaultLocale.toUpperCase()} — this content type requires body content before publishing.`,
          params: { variant: "body" },
          field: "body",
          locales: [cfg.defaultLocale],
        })
      } else {
        warnings.push({
          code: "missing_default_locale_content",
          severity: "warning",
          message: `Add at least one content section for ${cfg.defaultLocale.toUpperCase()} before publishing.`,
          field: "content.slices",
          locales: [cfg.defaultLocale],
        })
      }
    }

    if (!sliceBodyContent?.metaTitle?.trim() && !page.seo?.metaTitle?.trim()) {
      warnings.push({
        code: "missing_seo_title",
        severity: "warning",
        message: `Add an SEO title for ${cfg.defaultLocale.toUpperCase()} before publishing.`,
        field: "content.metaTitle",
        locales: [cfg.defaultLocale],
      })
    }

    if (
      !sliceBodyContent?.metaDescription?.trim() &&
      !page.seo?.metaDescription?.trim()
    ) {
      warnings.push({
        code: "missing_seo_description",
        severity: "warning",
        message: `Add an SEO description for ${cfg.defaultLocale.toUpperCase()} before publishing.`,
        field: "content.metaDescription",
        locales: [cfg.defaultLocale],
      })
    }
  }

  return {
    pageId: page._id,
    defaultLocale: cfg.defaultLocale,
    enabledLocales: cfg.enabledLocales,
    canPublish: blockers.length === 0,
    blockers,
    warnings,
  }
}

/**
 * Publish intent (plan 029 C9a) — the checklist runs in three moments:
 *
 * - `"edit"` (default) — intrinsic content checks only. This supports a
 *   save-only surface without requiring referenced pages to be public.
 * - `"readiness"` — the editor's pre-publish truth surface. Reference
 *   targets must already have a public version in every relevant locale so
 *   the UI blocks a publication that the server is guaranteed to refuse.
 * - `"publish"` — the gate before `pages.update` flips a page to
 *   `published`, before `pages.update` schedules a publish, or the
 *   scheduled-publish worker fires. At those moments the SOURCE is
 *   going public and descriptor relations must resolve to published
 *   targets.
 *
 * Reading intent from `page.status` was the C9a v1 shape (advisor-flagged
 * bug): a scheduled-publish still has `status="draft"` at scheduling time
 * AND at worker-fire time, so `page.status === "published"` was always
 * false on those paths and descriptor targets went unchecked.
 */
export type PrePublishIntent = "edit" | "readiness" | "publish"

export async function buildPrePublishChecklistWithReferences(
  ctx: QueryCtx | MutationCtx,
  page: Doc<"pages">,
  cfg: ChecklistLocaleConfig,
  intent: PrePublishIntent = "edit"
): Promise<PrePublishChecklist> {
  const checklist = buildPrePublishChecklist(page, cfg)
  const referencedPageLocales = new Map<Id<"pages">, Set<string>>()
  const descriptorRelations: DescriptorRelationSpec[] = []
  const descriptor = contentTypeDefs[page.pageType as ContentType]
  const typeLabel = descriptor?.label.singular ?? page.pageType
  const requiresPublicTargets = intent !== "edit"
  const publicationAuthority = requiresPublicTargets
    ? await readPublicationAuthority(ctx)
    : null
  const publicSnapshotReader =
    publicationAuthority === "snapshot_active"
      ? await createPublicSnapshotProjectionReader(ctx)
      : null
  // Descriptor shared fields — one pass, locale-agnostic. Empty required
  // shared fields are blockers (they gate the whole row's publish).
  if (descriptor) {
    walkDescriptorFieldMapForChecklist(
      descriptor.sharedFields as Record<string, Primitive>,
      page as unknown as Record<string, unknown>,
      {
        scope: "shared",
        severity: "blocker",
        requiresPublicTarget: requiresPublicTargets,
        typeLabel,
        contentType: page.pageType,
      },
      checklist.blockers,
      descriptorRelations
    )
  }

  for (const locale of cfg.enabledLocales) {
    const localized = page.content?.[locale]
    if (!localized) {
      checklist.warnings.push({
        code: "missing_enabled_locale_translation",
        severity: "warning",
        message: `Add ${locale.toUpperCase()} content before publishing to every enabled locale.`,
        field: `content.${locale}`,
        locales: [locale],
      })
      continue
    }

    // Descriptor localized fields — walked per applicable locale, with the
    // core-checked fields skipped (title/meta already covered).
    // N-locale policy: default locale is a blocker; secondary enabled
    // locales are warnings (matches the existing `missing_enabled_locale_
    // translation` policy — a locale is present but incomplete rather
    // than an outright blocker for the whole document).
    if (descriptor) {
      const localizedBag = localized as unknown as Record<string, unknown>
      walkDescriptorFieldMapForChecklist(
        descriptor.localizedFields as Record<string, Primitive>,
        localizedBag,
        {
          scope: { locale },
          severity: locale === cfg.defaultLocale ? "blocker" : "warning",
          requiresPublicTarget: requiresPublicTargets,
          typeLabel,
          contentType: page.pageType,
          skipLocalizedCoreChecked: true,
        },
        locale === cfg.defaultLocale ? checklist.blockers : checklist.warnings,
        descriptorRelations
      )
    }

    // Pure-form arms (`sliceBody: false`) don't carry a slice canvas — the
    // walk below only applies to slice-bodied arms.
    if (hasSliceBody(page)) {
      const sliceBodyLocalized = page.content?.[locale]
      for (const slice of sliceBodyLocalized?.slices ?? []) {
        if (!readSlice(slice).enabled) continue
        inspectSliceForChecklist(
          slice,
          locale,
          checklist.blockers,
          referencedPageLocales
        )
      }
    }
  }

  // Fetch every referenced target once — both the slice-reference map and
  // the descriptor relations may point at overlapping ids. Dedupe
  // via a single Map that both loops read.
  const allTargetIds = new Set<Id<"pages">>(referencedPageLocales.keys())
  for (const rel of descriptorRelations) allTargetIds.add(rel.targetId)
  const targetsList = await Promise.all(
    [...allTargetIds].map(async (id) => [id, await ctx.db.get(id)] as const)
  )
  const targetsById = new Map(targetsList)

  async function unavailableLocales(
    target: Doc<"pages">,
    locales: Iterable<string>
  ): Promise<string[]> {
    if (!requiresPublicTargets) return []
    const requested = [...new Set(locales)]
    if (publicationAuthority !== "snapshot_active") {
      return target.status === "published" ? [] : requested
    }
    if (!publicSnapshotReader) return requested
    const results = await Promise.all(
      requested.map(async (locale) => ({
        locale,
        projection: await publicSnapshotReader(target._id, locale),
      }))
    )
    return results
      .filter((result) => result.projection === null)
      .map((result) => result.locale)
  }

  function localeLabel(locales: readonly string[]): string {
    return locales.map((locale) => locale.toUpperCase()).join(", ")
  }

  const sliceRelationBlockers = await Promise.all(
    [...referencedPageLocales].map(
      async ([id, locales]): Promise<PrePublishChecklistItem | null> => {
        const target = targetsById.get(id)
        if (!target || target.deletedAt !== undefined) {
          return {
            code: "broken_internal_link",
            severity: "blocker",
            message:
              "This content refers to a page that no longer exists. Replace the reference before publishing.",
          }
        }
        const missingLocales = await unavailableLocales(target, locales)
        if (missingLocales.length === 0) return null
        return {
          code: "archived_relation_target",
          severity: "blocker",
          message:
            publicationAuthority === "snapshot_active"
              ? `"${pickPageTitle(target)}" isn't published in ${localeLabel(missingLocales)}. Publish it first or replace the reference before publishing.`
              : `"${pickPageTitle(target)}" isn't published. Publish it first or replace the reference before publishing.`,
          params: {
            ...checklistTargetTitleParams(target),
            localeSpecific: publicationAuthority === "snapshot_active",
          },
          locales: missingLocales,
        }
      }
    )
  )
  checklist.blockers.push(
    ...sliceRelationBlockers.filter(
      (item): item is PrePublishChecklistItem => item !== null
    )
  )

  // Descriptor-relation loop uses descriptor-aware wording and threads
  // the field/locales metadata. The `pageTypes` allowlist check is
  // genuinely new (slice relations don't declare an allowlist). Publish-
  // state check runs for readiness and publish intent, while ordinary save
  // remains independent from the checklist query.
  const descriptorRelationBlockers = await Promise.all(
    descriptorRelations.map(
      async (rel): Promise<PrePublishChecklistItem | null> => {
        const target = targetsById.get(rel.targetId)
        if (!target || target.deletedAt !== undefined) {
          return {
            code: "broken_internal_link",
            severity: "blocker",
            message: `This ${typeLabel} refers to a page that no longer exists. Replace the reference before publishing.`,
            params: { contentType: page.pageType },
            field: rel.field,
            locales: rel.locales,
          }
        }
        if (
          rel.allowedTypes.length > 0 &&
          !rel.allowedTypes.includes(target.pageType)
        ) {
          return {
            code: "broken_internal_link",
            severity: "blocker",
            message: `This ${typeLabel} refers to "${pickPageTitle(target)}", which is not an allowed content type here. Choose a different page.`,
            params: {
              variant: "disallowed_type",
              contentType: page.pageType,
              ...checklistTargetTitleParams(target),
            },
            field: rel.field,
            locales: rel.locales,
          }
        }
        const missingLocales = rel.requiresPublicTarget
          ? await unavailableLocales(target, rel.locales ?? cfg.enabledLocales)
          : []
        if (missingLocales.length === 0) return null
        return {
          code: "archived_relation_target",
          severity: "blocker",
          message:
            publicationAuthority === "snapshot_active"
              ? `"${pickPageTitle(target)}" isn't published in ${localeLabel(missingLocales)}. Publish it first or choose another page before publishing this ${typeLabel}.`
              : `"${pickPageTitle(target)}" isn't published. Publish it first or choose another page before publishing this ${typeLabel}.`,
          params: {
            contentType: page.pageType,
            ...checklistTargetTitleParams(target),
            localeSpecific: publicationAuthority === "snapshot_active",
          },
          field: rel.field,
          locales: missingLocales,
        }
      }
    )
  )
  checklist.blockers.push(
    ...descriptorRelationBlockers.filter(
      (item): item is PrePublishChecklistItem => item !== null
    )
  )

  return {
    ...checklist,
    canPublish: checklist.blockers.length === 0,
  }
}

export async function assertPrePublishAllowed(
  ctx: QueryCtx | MutationCtx,
  page: Doc<"pages">,
  cfg: ChecklistLocaleConfig
): Promise<PrePublishChecklist> {
  const checklist = await buildPrePublishChecklistWithReferences(
    ctx,
    page,
    cfg,
    "publish"
  )
  if (checklist.canPublish) return checklist
  throw new ConvexError(
    `Resolve pre-publish blockers before publishing: ${checklist.blockers
      .map((item) => item.message)
      .join(" ")}`
  )
}

function compactChecklistItems(items: PrePublishChecklistItem[]) {
  return items.map(({ code, message, field, locales }) => ({
    code,
    message,
    ...(field !== undefined ? { field } : {}),
    ...(locales !== undefined ? { locales } : {}),
  }))
}

export function snapshotPrePublishChecklist(
  checklist: PrePublishChecklist
): PageRevisionChecklistSnapshot {
  return {
    blockerCount: checklist.blockers.length,
    warningCount: checklist.warnings.length,
    blockers: compactChecklistItems(checklist.blockers),
    warnings: compactChecklistItems(checklist.warnings),
  }
}
