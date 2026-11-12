import { ConvexError, v } from "convex/values"
import { mutation, query } from "../_generated/server"
import {
  requireInstallationOwner,
  requireOperationAccess,
} from "../lib/access/policy"
import {
  SLICE_AUTHORING_STATE_VERSION,
  sliceAuthoringContractState,
} from "../lib/slices/authoringState"
import { REGISTERED_SLICE_TYPES } from "../lib/slices"
// @starter-projection:hero-presentations:start
import { HERO_PRESENTATION_DEFINITIONS } from "../lib/slices/heroPresentationDefinitions"
// @starter-projection:hero-presentations:end
import {
  readEffectiveSlicePresentationCatalog,
  readSlicePresentationCatalog,
  resolveSlicePresentation,
  slicePresentationCatalogWithArchives,
  type SlicePresentationCatalog,
  SLICE_PRESENTATION_CATALOG_VERSION,
} from "../lib/slices/presentations"
import { hasOwnedSlicePresentationRenderer } from "../lib/slices/presentationRendererInventory"

// @starter-projection:hero-presentations:start
const registeredSliceTypes: readonly string[] = REGISTERED_SLICE_TYPES
// @starter-projection:hero-presentations:end

const presentationFields = {
  label: v.string(),
  state: v.union(
    v.literal("active"),
    v.literal("archived"),
    v.literal("unavailable")
  ),
  installed: v.boolean(),
  contractSha256: v.string(),
  rendererSource: v.string(),
}

const presentationCatalogValidator = v.object({
  version: v.literal(SLICE_PRESENTATION_CATALOG_VERSION),
  revision: v.string(),
  installedTypes: v.array(v.string()),
  contractDigests: v.record(v.string(), v.string()),
  entries: v.array(
    v.union(
      v.object({
        ...presentationFields,
        type: v.union(...REGISTERED_SLICE_TYPES.map((type) => v.literal(type))),
        id: v.literal("default"),
      }),
      // @starter-projection:hero-presentations:start
      ...(registeredSliceTypes.includes("hero-with-image")
        ? [
            v.object({
              ...presentationFields,
              type: v.literal("hero-with-image"),
              id: v.union(
                ...HERO_PRESENTATION_DEFINITIONS.map(({ id }) => v.literal(id))
              ),
            }),
          ]
        : [])
      // @starter-projection:hero-presentations:end
    )
  ),
})

function catalogValue(catalog: SlicePresentationCatalog) {
  return {
    ...catalog,
    installedTypes: [...catalog.installedTypes],
    contractDigests: { ...catalog.contractDigests },
    entries: [...catalog.entries],
  }
}

/** Owner-authenticated effective choices for new Page assignments. */
export const getPresentationCatalog = query({
  args: {},
  returns: presentationCatalogValidator,
  handler: async (ctx) => {
    await requireOperationAccess(ctx)
    return catalogValue(await readEffectiveSlicePresentationCatalog(ctx))
  },
})

function assertAvailableDefault(
  catalog: SlicePresentationCatalog,
  type: string
) {
  const resolution = resolveSlicePresentation(catalog, {
    type,
    presentationId: "default",
    intent: "new-assignment",
    expectedCatalogRevision: catalog.revision,
  })
  if (
    resolution.status !== "resolved" ||
    !hasOwnedSlicePresentationRenderer(type, "default")
  )
    throw new ConvexError("SLICE_PRESENTATION_DEFAULT_UNAVAILABLE")
}

/** Curation only: retained content, renderer code and public freshness stay put. */
export const setPresentationArchived = mutation({
  args: {
    type: v.string(),
    presentationId: v.string(),
    archived: v.boolean(),
    expectedCatalogRevision: v.string(),
  },
  returns: presentationCatalogValidator,
  handler: async (ctx, args) => {
    await requireOperationAccess(ctx)
    const rows = await ctx.db.query("siteSettings").take(2)
    if (rows.length > 1)
      throw new ConvexError("SLICE_PRESENTATION_SETTINGS_INVALID")
    const settings = rows[0]
    if (!settings || settings.onboardingCompletedAt === undefined)
      throw new ConvexError("SLICE_PRESENTATION_SETTINGS_UNINITIALIZED")
    const source = await readSlicePresentationCatalog()
    const archived = settings.archivedSlicePresentationsV1 ?? []
    const current = await slicePresentationCatalogWithArchives(source, archived)
    if (args.expectedCatalogRevision !== current.revision)
      throw new ConvexError("SLICE_PRESENTATION_CATALOG_STALE")

    const keys = new Set<string>()
    for (const membership of archived) {
      const key = JSON.stringify([membership.type, membership.presentationId])
      if (
        membership.presentationId === "default" ||
        keys.has(key) ||
        !source.entries.some(
          (entry) =>
            entry.type === membership.type &&
            entry.id === membership.presentationId
        )
      )
        throw new ConvexError("SLICE_PRESENTATION_MEMBERSHIPS_INVALID")
      keys.add(key)
    }
    if (args.presentationId === "default")
      throw new ConvexError("SLICE_PRESENTATION_DEFAULT_REQUIRED")
    const target = resolveSlicePresentation(source, {
      type: args.type,
      presentationId: args.presentationId,
      intent: "new-assignment",
      expectedCatalogRevision: source.revision,
    })
    if (
      target.status !== "resolved" ||
      !hasOwnedSlicePresentationRenderer(args.type, args.presentationId)
    )
      throw new ConvexError("SLICE_PRESENTATION_SOURCE_UNAVAILABLE")
    assertAvailableDefault(current, args.type)
    const key = JSON.stringify([args.type, args.presentationId])
    if (keys.has(key) === args.archived) return catalogValue(current)
    const next = args.archived
      ? [...archived, { type: args.type, presentationId: args.presentationId }]
      : archived.filter(
          (membership) =>
            JSON.stringify([membership.type, membership.presentationId]) !== key
        )
    const proposed = await slicePresentationCatalogWithArchives(source, next)
    assertAvailableDefault(proposed, args.type)
    await ctx.db.patch("siteSettings", settings._id, {
      archivedSlicePresentationsV1: next,
      updatedAt: Date.now(),
    })
    return catalogValue(proposed)
  },
})

/**
 * Server-side curation state for the slice catalog (ADR archive-vs-delete).
 *
 * Archiving is deliberately NOT the dev-only, typecheck-gated file rewrite that
 * deletion is: it's a flag on the `siteSettings` singleton, so it's instant,
 * reversible, and works on a deployed (production) install. The slice code stays
 * registered — existing pages keep rendering — the type just leaves the
 * authoring picker and the catalog's "Active" view.
 */

// Single-tenant: exactly one siteSettings row (mirrors cms/settings.ts).
export const getArchivedSliceTypes = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    await requireOperationAccess(ctx)
    const settings = await ctx.db.query("siteSettings").first()
    return settings?.archivedSliceTypes ?? []
  },
})

/** Owner-authenticated read for the app-local CLI; absent setup stays unknown. */
export const getSliceAuthoringState = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      version: v.literal(SLICE_AUTHORING_STATE_VERSION),
      settingsId: v.id("siteSettings"),
      registeredTypes: v.array(v.string()),
      installedTypes: v.array(v.string()),
      contracts: v.string(),
      archivedTypes: v.array(v.string()),
    })
  ),
  handler: async (ctx) => {
    await requireInstallationOwner(ctx)
    const settings = await ctx.db.query("siteSettings").first()
    if (!settings) return null
    return {
      ...sliceAuthoringContractState(),
      settingsId: settings._id,
      archivedTypes: settings.archivedSliceTypes ?? [],
    }
  },
})
