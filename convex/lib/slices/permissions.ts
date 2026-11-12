import { readSliceDefinition } from "@/convex/lib/slices"
import { readSlice } from "@/convex/lib/slices/identity"
import { toDescriptorComparisonForm } from "../richtext/comparison"
// convex/lib/slices/permissions.ts
// Slice mutation integrity guards for page write paths.
//
// Slices live inside `pages.content[locale].slices[]`, so slice mutations are
// carried by page-level `create` / `update` / `duplicate` / `restoreRevisionAsDraft`
// mutations rather than dedicated slice endpoints. The permission registry
// exposes a `slices.<type>:add|edit|delete` triple per slice type. Community
// authorizes the containing operation through F01's owner seam; this module
// retains the content-diff and archived-type integrity guards that remain
// necessary after role/permission authority is removed.

import { ConvexError } from "convex/values"
import type { QueryCtx, MutationCtx } from "../../_generated/server"
import { requireOperationAccess } from "../access/policy"
import type { OwnerPrincipal } from "../access/owner"
import { type Primitive, type Slice } from "."
import { assertSliceProfileContent } from "./profile"
import { readEffectiveSlicePresentationCatalog } from "./presentations"
import {
  assertSlicePresentationMutation,
  hasExplicitSlicePresentations,
  type SlicePresentationMutationOptions,
} from "./presentationMutations"

// Deliberately permissive — `diffSliceMutations` only cares about `slices`,
// but the concrete `Doc<"pages">["content"]` union contains arms without a
// `slices` field (testimonial, plan 029 C10). `[key: string]: unknown`
// dodges TS's weak-type rule so a pure-form arm passes through as "no slice
// changes", which is the correct semantic — it has none.
type LocaleContent =
  | { readonly slices?: readonly Slice[]; readonly [key: string]: unknown }
  | undefined
type ContentMap = Record<string, LocaleContent> | undefined

export type SliceMutationActions = {
  add: Set<string>
  edit: Set<string>
  delete: Set<string>
}

/** Set of slice types present anywhere in a content map (any locale). */
function typesPresent(content: ContentMap): Set<string> {
  const set = new Set<string>()
  for (const locale of Object.keys(content ?? {})) {
    for (const s of content?.[locale]?.slices ?? []) set.add(readSlice(s).type)
  }
  return set
}

/**
 * Diff two content maps and report the set of slice types added / edited /
 * deleted going from `before` to `after`.
 *
 * Type presence is compared across the Page. Each new occurrence also records
 * an add in its locale, even if that Type already exists elsewhere on the Page:
 * archiving preserves existing occurrences but forbids new assignments.
 *
 * `edit` is decided per-locale, matched by slice `id`. Same-id-different-type
 * still records both add-on-new and delete-on-old at the page level (matching
 * how a slice type swap is authored).
 */
export function diffSliceMutations(
  before: ContentMap,
  after: ContentMap
): SliceMutationActions {
  const actions: SliceMutationActions = {
    add: new Set(),
    edit: new Set(),
    delete: new Set(),
  }
  const beforeTypes = typesPresent(before)
  const afterTypes = typesPresent(after)
  for (const type of afterTypes) {
    if (!beforeTypes.has(type)) actions.add.add(type)
  }
  for (const type of beforeTypes) {
    if (!afterTypes.has(type)) actions.delete.add(type)
  }
  const locales = new Set<string>([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ])
  for (const locale of locales) {
    const oldSlices = before?.[locale]?.slices ?? []
    const newSlices = after?.[locale]?.slices ?? []
    const oldById = new Map<string, Slice>()
    for (const s of oldSlices) oldById.set(readSlice(s).id, s)
    for (const s of newSlices) {
      const prev = oldById.get(readSlice(s).id)
      if (!prev) {
        actions.add.add(readSlice(s).type)
        continue
      }
      if (readSlice(prev).type !== readSlice(s).type) {
        // A same-id type swap acts as add-on-new + delete-on-old regardless of
        // whether the pre-swap type still lives elsewhere on the page.
        actions.add.add(readSlice(s).type)
        actions.delete.add(readSlice(prev).type)
        continue
      }
      if (!sameSliceIgnoringInitializedItemIds(prev, s)) {
        actions.edit.add(readSlice(s).type)
      }
    }
  }
  return actions
}

function sameSliceIgnoringInitializedItemIds(
  before: Slice,
  after: Slice
): boolean {
  const def = readSliceDefinition(readSlice(after).type)
  if (!def) return JSON.stringify(before) === JSON.stringify(after)
  const normalized = Object.assign({}, after, {
    primary: normalizeInitialItemIds(
      def.primary,
      readSlice(before).primary,
      readSlice(after).primary
    ),
  }) as Record<string, unknown>
  if (def.items !== undefined && "items" in before && "items" in after) {
    normalized.items = normalizeInitialItemIds(
      def.items,
      readSlice(before).items,
      readSlice(after).items
    )
  }
  const comparison = (slice: Slice) =>
    Object.assign(
      {},
      slice,
      {
        primary: toDescriptorComparisonForm(
          def.primary,
          readSlice(slice).primary,
          {
            sliceType: readSlice(slice).type,
            fieldPath: "primary",
          }
        ),
      },
      def.items !== undefined && "items" in slice
        ? {
            items: toDescriptorComparisonForm(
              def.items,
              readSlice(slice).items,
              {
                sliceType: readSlice(slice).type,
                fieldPath: "items",
              }
            ),
          }
        : {}
    )
  return (
    JSON.stringify(comparison(before)) ===
    JSON.stringify(comparison(normalized as Slice))
  )
}

function normalizeInitialItemIds(
  def: Primitive,
  before: unknown,
  after: unknown
): unknown {
  if (def.kind === "group") {
    if (!isRecord(before) || !isRecord(after)) return after
    const fields = def.config.fields as Record<string, Primitive>
    const next: Record<string, unknown> = { ...after }
    for (const [key, child] of Object.entries(fields)) {
      next[key] = normalizeInitialItemIds(child, before[key], after[key])
    }
    return next
  }
  if (def.kind === "list") {
    if (
      !Array.isArray(before) ||
      !Array.isArray(after) ||
      before.length !== after.length
    )
      return after
    const item = def.config.item as Primitive
    return after.map((row, index) => {
      const previous = before[index]
      const normalized = normalizeInitialItemIds(item, previous, row)
      if (
        item.validator.kind !== "object" ||
        !isRecord(previous) ||
        !isRecord(normalized) ||
        !isRecord(row)
      )
        return normalized
      if (
        Object.prototype.hasOwnProperty.call(previous, "itemId") ||
        typeof row.itemId !== "string" ||
        !row.itemId
      )
        return normalized
      const withoutId = { ...normalized }
      delete withoutId.itemId
      return JSON.stringify(previous) === JSON.stringify(withoutId)
        ? withoutId
        : normalized
    })
  }
  return after
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Verifies ordinary Community operation access and rejects archived slice
 * types from an add diff. The latter is record integrity, not authorization:
 * archived type data remains readable for history but cannot re-enter active
 * page content through create, update, duplicate, draft restore, or save.
 */
export async function requireSliceMutationsPermitted(
  ctx: QueryCtx | MutationCtx,
  actions: SliceMutationActions,
  options: SlicePresentationMutationOptions = {}
): Promise<void> {
  await requireOperationAccess(ctx)
  await assertSliceMutationIntegrity(ctx, actions, options)
}

/**
 * The record-integrity half of `requireSliceMutationsPermitted`, without the
 * access check. Only direct domain functions whose registered caller already
 * authenticated (or whose internal worker acts under a recorded owner
 * attribution, such as an F09 language transition) may call it directly.
 */
export async function assertSliceMutationIntegrity(
  ctx: QueryCtx | MutationCtx,
  actions: SliceMutationActions,
  options: SlicePresentationMutationOptions = {}
): Promise<void> {
  assertSliceProfileContent(options.operation ?? "edit", [
    options.existingContent,
    options.content,
  ])

  if (actions.add.size > 0) {
    const settings = await ctx.db.query("siteSettings").first()
    const archived = new Set(settings?.archivedSliceTypes ?? [])
    for (const type of actions.add) {
      if (archived.has(type)) {
        throw new ConvexError(
          `Archived Block Type "${type}" cannot be added to a Page.`
        )
      }
    }
  }
  if (
    hasExplicitSlicePresentations([options.existingContent, options.content])
  ) {
    // Owned source plus transaction-owned archive state, never a client catalog.
    assertSlicePresentationMutation(
      await readEffectiveSlicePresentationCatalog(ctx),
      options
    )
  }
}

/**
 * Slice Type retirement is a site-wide destructive maintenance operation.
 * It remains owner-gated even though Community has no configurable grants.
 */
export async function requireSliceTypeRetirementPermission(
  ctx: QueryCtx | MutationCtx,
  type: string
): Promise<OwnerPrincipal> {
  void type
  return requireOperationAccess(ctx)
}
