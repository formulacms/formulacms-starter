import type { BlockType } from "./index"
// @starter-projection:hero-presentations:start
import { HERO_PRESENTATION_DEFINITIONS } from "./heroPresentationDefinitions"
// @starter-projection:hero-presentations:end

export const BLOCK_PRESENTATION_CATALOG_VERSION = "block-presentations-v1"
export type BlockPresentationId =
  | "default"
  // @starter-projection:hero-presentations:start
  | (typeof HERO_PRESENTATION_DEFINITIONS)[number]["id"]
// @starter-projection:hero-presentations:end
export type BlockPresentationState = "active" | "archived" | "unavailable"

// @starter-projection:hero-presentations:start
/**
 * SHA-256 of the exact Hero descriptor bytes in authoringState's JSON format.
 * Conservatively includes validator/default/preview/hint metadata. Any change
 * requires review and repinning; matching bytes do not prove visual semantics.
 */
export const HERO_PRESENTATION_CONTRACT_SHA256 =
  HERO_PRESENTATION_DEFINITIONS[0].contractSha256
// @starter-projection:hero-presentations:end

export type BlockPresentationEntry = Readonly<
  {
    label: string
    state: BlockPresentationState
    /** Source implementation availability, not public reader rollout proof. */
    installed: boolean
    contractSha256: string
    rendererSource: string
  } & (
    // @starter-projection:hero-presentations:start
    | { type: "hero-with-image"; id: Exclude<BlockPresentationId, "default"> }
    // @starter-projection:hero-presentations:end
    | { type: BlockType; id: "default" }
  )
>

export type BlockPresentationCatalog = Readonly<{
  version: typeof BLOCK_PRESENTATION_CATALOG_VERSION
  revision: string
  installedTypes: readonly string[]
  contractDigests: Readonly<Record<string, string>>
  entries: readonly BlockPresentationEntry[]
}>

export type BlockPresentationRequest = {
  type: string
  presentationId?: string
} & (
  | { intent: "new-assignment"; expectedCatalogRevision: string }
  | { intent: "existing" | "historical" }
)

type PresentationIdentity = {
  type: string
  /** null preserves legacy absence; unknown retained IDs stay unchanged. */
  requestedId: string | null
  catalogRevision: string
}

export type BlockPresentationRefusalReason =
  | "type-unavailable"
  | "catalog-unavailable"
  | "catalog-stale"
  | "invalid-intent"
  | "invalid-presentation-id"
  | "presentation-missing"
  | "presentation-archived"
  | "presentation-unavailable"
  | "contract-incompatible"
  | "fallback-unavailable"

export type BlockPresentationResolution = PresentationIdentity &
  (
    | {
        status: "resolved"
        resolvedId: BlockPresentationId
        legacyDefault: boolean
        renderable: true
        newAssignable: boolean
      }
    | {
        status: "fallback"
        resolvedId: "default"
        reason: BlockPresentationRefusalReason
        renderable: true
        newAssignable: false
      }
    | {
        status: "refused"
        reason: BlockPresentationRefusalReason
        requestedReason?: BlockPresentationRefusalReason
        renderable: false
        newAssignable: false
      }
  )

function entryProblem(
  catalog: BlockPresentationCatalog,
  entry: BlockPresentationEntry | undefined
): BlockPresentationRefusalReason | null {
  if (!entry) return "presentation-missing"
  if (
    !entry.installed ||
    (entry.state !== "active" && entry.state !== "archived")
  )
    return "presentation-unavailable"
  if (
    !Object.hasOwn(catalog.contractDigests, entry.type) ||
    entry.contractSha256 !== catalog.contractDigests[entry.type]
  )
    return "contract-incompatible"
  return null
}

/**
 * Resolve one whole occurrence decision against an owned, trusted snapshot.
 * The caller must obtain this catalog from installed source, never client input.
 * Eligibility is presentation policy only; owner/Type/write/reader checks remain
 * the authoritative integration's responsibility. Historical intent does not
 * itself authorize restoring a Page or publishing an archived choice.
 */
export function resolveBlockPresentation(
  catalog: BlockPresentationCatalog,
  request: BlockPresentationRequest
): BlockPresentationResolution {
  const identity: PresentationIdentity = {
    type: request.type,
    requestedId: request.presentationId ?? null,
    catalogRevision: catalog.revision,
  }
  const refused = (
    reason: BlockPresentationRefusalReason,
    requestedReason?: BlockPresentationRefusalReason
  ): BlockPresentationResolution => ({
    ...identity,
    status: "refused",
    reason,
    ...(requestedReason ? { requestedReason } : {}),
    renderable: false,
    newAssignable: false,
  })
  // An absent Type is a whole-operation blocker, never a presentation fallback.
  if (!catalog.installedTypes.includes(request.type))
    return refused("type-unavailable")
  if (
    catalog.version !== BLOCK_PRESENTATION_CATALOG_VERSION ||
    typeof catalog.revision !== "string" ||
    /^sha256:[a-f0-9]{64}$/.exec(catalog.revision)?.[0] !== catalog.revision
  )
    return refused("catalog-unavailable")
  if (
    request.intent !== "new-assignment" &&
    request.intent !== "existing" &&
    request.intent !== "historical"
  )
    return refused("invalid-intent")
  if (
    request.intent === "new-assignment" &&
    request.expectedCatalogRevision !== catalog.revision
  )
    return refused("catalog-stale")
  if (
    request.presentationId !== undefined &&
    (typeof request.presentationId !== "string" ||
      request.presentationId.length > 64 ||
      /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.exec(request.presentationId)?.[0] !==
        request.presentationId)
  )
    return refused("invalid-presentation-id")

  const selected = catalog.entries.find(
    (entry) =>
      entry.type === request.type &&
      entry.id === (request.presentationId ?? "default")
  )
  const problem = entryProblem(catalog, selected)
  if (!problem && selected) {
    if (request.intent === "new-assignment" && selected.state === "archived")
      return refused("presentation-archived")
    return {
      ...identity,
      status: "resolved",
      resolvedId: selected.id,
      legacyDefault: request.presentationId === undefined,
      renderable: true,
      newAssignable: selected.state === "active",
    }
  }
  if (request.intent === "new-assignment")
    return refused(problem ?? "presentation-unavailable")
  const fallback = catalog.entries.find(
    (entry) => entry.type === request.type && String(entry.id) === "default"
  )
  if (entryProblem(catalog, fallback))
    return refused("fallback-unavailable", problem ?? undefined)
  return {
    ...identity,
    status: "fallback",
    resolvedId: "default",
    reason: problem ?? "presentation-unavailable",
    renderable: true,
    newAssignable: false,
  }
}
