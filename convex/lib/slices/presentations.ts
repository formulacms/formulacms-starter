import { REGISTERED_SLICE_TYPES } from "./index"
import { sliceAuthoringContractState } from "./authoringState"
// @starter-projection:hero-presentations:start
import { HERO_PRESENTATION_DEFINITIONS } from "./heroPresentationDefinitions"
// @starter-projection:hero-presentations:end
import { ConvexError } from "convex/values"
import type { QueryCtx, MutationCtx } from "../../_generated/server"
import {
  SLICE_PRESENTATION_CATALOG_VERSION,
  type SlicePresentationCatalog,
  type SlicePresentationEntry,
} from "./presentationResolution"

// Browser consumers import the pure resolution module directly. This server
// catalog retains compatibility exports without sending validators to clients.
export * from "./presentationResolution"

async function sha256(bytes: string): Promise<string> {
  // Web Crypto is supported by ordinary Convex queries/mutations. No Node API.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(bytes)
  )
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`
}

/** Catalog/contract/profile revision only; excludes renderer/helper/CSS bytes. */
export function slicePresentationCatalogRevision(
  catalog: Omit<SlicePresentationCatalog, "revision">
): Promise<string> {
  return sha256(
    JSON.stringify({
      version: catalog.version,
      installedTypes: [...catalog.installedTypes].sort(),
      contracts: Object.entries(catalog.contractDigests).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0
      ),
      entries: catalog.entries
        .map((entry) => [
          entry.type,
          entry.id,
          entry.label,
          entry.state,
          entry.installed,
          entry.contractSha256,
          entry.rendererSource,
        ])
        .sort(([typeA, idA], [typeB, idB]) => {
          const a = JSON.stringify([typeA, idA])
          const b = JSON.stringify([typeB, idB])
          return a < b ? -1 : a > b ? 1 : 0
        }),
    })
  )
}

/**
 * Owned source catalog. This prerequisite creates no stored choice, lifecycle
 * writer, qualification verdict or publication authority. All non-pilot Types
 * keep their existing default. Hero definitions and static dispatch are owned
 * source; acceptance must gate their complete write set before registration.
 */
export async function readSlicePresentationCatalog(): Promise<SlicePresentationCatalog> {
  const state = sliceAuthoringContractState()
  const serializedDefs = JSON.parse(state.contracts) as Record<string, unknown>
  const contractDigests = Object.fromEntries(
    await Promise.all(
      REGISTERED_SLICE_TYPES.map(async (type) => [
        type,
        await sha256(JSON.stringify(serializedDefs[type])),
      ])
    )
  )
  // @starter-projection:hero-presentations:start
  const heroEntries = HERO_PRESENTATION_DEFINITIONS.map((definition) => ({
    type: "hero-with-image",
    id: definition.id,
    label: definition.label,
    state: definition.state,
    installed: definition.installed,
    contractSha256: definition.contractSha256,
    rendererSource: definition.rendererSource,
  }))
  // @starter-projection:hero-presentations:end
  const entries: SlicePresentationEntry[] = REGISTERED_SLICE_TYPES.map(
    (type) => ({
      label: "Default",
      state: "active" as const,
      installed: true,
      contractSha256: contractDigests[type],
      rendererSource: `components/slices/${type}.tsx`,
      // @starter-projection:hero-presentations:start
      ...(String(type) === "hero-with-image" ? heroEntries[0] : {}),
      // @starter-projection:hero-presentations:end
      type,
      id: "default" as const,
    })
  )
  // @starter-projection:hero-presentations:start
  const registeredTypes: readonly string[] = REGISTERED_SLICE_TYPES
  if (registeredTypes.includes("hero-with-image")) {
    for (const { id, ...entry } of heroEntries) {
      if (id !== "default")
        entries.push({ ...entry, type: "hero-with-image", id })
    }
  }
  // @starter-projection:hero-presentations:end
  const catalog: Omit<SlicePresentationCatalog, "revision"> = {
    version: SLICE_PRESENTATION_CATALOG_VERSION,
    installedTypes: Object.freeze([...state.installedTypes]),
    contractDigests: Object.freeze(contractDigests),
    entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
  }
  return Object.freeze({
    ...catalog,
    revision: await slicePresentationCatalogRevision(catalog),
  })
}

export type ArchivedSlicePresentation = {
  type: string
  presentationId: string
}

/** Overlay only recognized source choices; stale memberships are read-only. */
export async function slicePresentationCatalogWithArchives(
  source: SlicePresentationCatalog,
  archived: readonly ArchivedSlicePresentation[]
): Promise<SlicePresentationCatalog> {
  const keys = new Set(
    archived.map(({ type, presentationId }) =>
      JSON.stringify([type, presentationId])
    )
  )
  const entries = source.entries.map((entry) =>
    entry.state === "active" && keys.has(JSON.stringify([entry.type, entry.id]))
      ? Object.freeze({ ...entry, state: "archived" as const })
      : entry
  )
  if (entries.every((entry, index) => entry === source.entries[index]))
    return source
  const catalog = { ...source, entries: Object.freeze(entries) }
  return Object.freeze({
    ...catalog,
    revision: await slicePresentationCatalogRevision(catalog),
  })
}

/** Transaction-owned assignment catalog; render-only readers stay source-only. */
export async function readEffectiveSlicePresentationCatalog(
  ctx: QueryCtx | MutationCtx
): Promise<SlicePresentationCatalog> {
  const rows = await ctx.db.query("siteSettings").take(2)
  if (rows.length > 1)
    throw new ConvexError("SLICE_PRESENTATION_SETTINGS_INVALID")
  return slicePresentationCatalogWithArchives(
    await readSlicePresentationCatalog(),
    rows[0]?.archivedSlicePresentationsV1 ?? []
  )
}
