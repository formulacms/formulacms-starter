import { ConvexError, v } from "convex/values"
import { nextUpdatedAt } from "../lib/versions"
import { mutation, query } from "../_generated/server"
import {
  requireInstallationOwner,
  requireOperationAccess,
} from "../lib/access/policy"
import {
  BLOCK_AUTHORING_STATE_VERSION,
  blockAuthoringContractState,
} from "../lib/blocks/authoringState"
import { REGISTERED_BLOCK_TYPES } from "../lib/blocks"
// @starter-projection:hero-presentations:start
import { HERO_PRESENTATION_DEFINITIONS } from "../lib/blocks/heroPresentationDefinitions"
// @starter-projection:hero-presentations:end
import {
  readEffectiveBlockPresentationCatalog,
  readBlockPresentationCatalog,
  resolveBlockPresentation,
  blockPresentationCatalogWithArchives,
  type BlockPresentationCatalog,
  BLOCK_PRESENTATION_CATALOG_VERSION,
} from "../lib/blocks/presentations"
import { hasOwnedBlockPresentationRenderer } from "../lib/blocks/presentationRendererInventory"

// @starter-projection:hero-presentations:start
const registeredBlockTypes: readonly string[] = REGISTERED_BLOCK_TYPES
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
  version: v.literal(BLOCK_PRESENTATION_CATALOG_VERSION),
  revision: v.string(),
  installedTypes: v.array(v.string()),
  contractDigests: v.record(v.string(), v.string()),
  entries: v.array(
    v.union(
      v.object({
        ...presentationFields,
        type: v.union(...REGISTERED_BLOCK_TYPES.map((type) => v.literal(type))),
        id: v.literal("default"),
      }),
      // @starter-projection:hero-presentations:start
      ...(registeredBlockTypes.includes("hero-with-image")
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

function catalogValue(catalog: BlockPresentationCatalog) {
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
    return catalogValue(await readEffectiveBlockPresentationCatalog(ctx))
  },
})

function assertAvailableDefault(
  catalog: BlockPresentationCatalog,
  type: string
) {
  const resolution = resolveBlockPresentation(catalog, {
    type,
    presentationId: "default",
    intent: "new-assignment",
    expectedCatalogRevision: catalog.revision,
  })
  if (
    resolution.status !== "resolved" ||
    !hasOwnedBlockPresentationRenderer(type, "default")
  )
    throw new ConvexError("BLOCK_PRESENTATION_DEFAULT_UNAVAILABLE")
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
      throw new ConvexError("BLOCK_PRESENTATION_SETTINGS_INVALID")
    const settings = rows[0]
    if (!settings || settings.onboardingCompletedAt === undefined)
      throw new ConvexError("BLOCK_PRESENTATION_SETTINGS_UNINITIALIZED")
    const source = await readBlockPresentationCatalog()
    const archived = settings.archivedBlockPresentationsV1 ?? []
    const current = await blockPresentationCatalogWithArchives(source, archived)
    if (args.expectedCatalogRevision !== current.revision)
      throw new ConvexError("BLOCK_PRESENTATION_CATALOG_STALE")

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
        throw new ConvexError("BLOCK_PRESENTATION_MEMBERSHIPS_INVALID")
      keys.add(key)
    }
    if (args.presentationId === "default")
      throw new ConvexError("BLOCK_PRESENTATION_DEFAULT_REQUIRED")
    const target = resolveBlockPresentation(source, {
      type: args.type,
      presentationId: args.presentationId,
      intent: "new-assignment",
      expectedCatalogRevision: source.revision,
    })
    if (
      target.status !== "resolved" ||
      !hasOwnedBlockPresentationRenderer(args.type, args.presentationId)
    )
      throw new ConvexError("BLOCK_PRESENTATION_SOURCE_UNAVAILABLE")
    assertAvailableDefault(current, args.type)
    const key = JSON.stringify([args.type, args.presentationId])
    if (keys.has(key) === args.archived) return catalogValue(current)
    const next = args.archived
      ? [...archived, { type: args.type, presentationId: args.presentationId }]
      : archived.filter(
          (membership) =>
            JSON.stringify([membership.type, membership.presentationId]) !== key
        )
    const proposed = await blockPresentationCatalogWithArchives(source, next)
    assertAvailableDefault(proposed, args.type)
    await ctx.db.patch("siteSettings", settings._id, {
      archivedBlockPresentationsV1: next,
      updatedAt: nextUpdatedAt(settings.updatedAt, Date.now()),
    })
    return catalogValue(proposed)
  },
})

/**
 * Server-side curation state for the block catalog (ADR archive-vs-delete).
 *
 * Archiving is deliberately NOT the dev-only, typecheck-gated file rewrite that
 * deletion is: it's a flag on the `siteSettings` singleton, so it's instant,
 * reversible, and works on a deployed (production) install. The block code stays
 * registered — existing pages keep rendering — the type just leaves the
 * authoring picker and the catalog's "Active" view.
 */

// Single-tenant: exactly one siteSettings row (mirrors cms/settings.ts).
export const getArchivedBlockTypes = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    await requireOperationAccess(ctx)
    const settings = await ctx.db.query("siteSettings").first()
    return settings?.archivedBlockTypes ?? []
  },
})

/** Owner-authenticated read for the app-local CLI; absent setup stays unknown. */
export const getBlockAuthoringState = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      version: v.literal(BLOCK_AUTHORING_STATE_VERSION),
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
      ...blockAuthoringContractState(),
      settingsId: settings._id,
      archivedTypes: settings.archivedBlockTypes ?? [],
    }
  },
})
