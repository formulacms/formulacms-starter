import {
  resolveSlicePresentation,
  type SlicePresentationCatalog,
  type SlicePresentationId,
  type SlicePresentationRefusalReason,
  type SlicePresentationResolution,
} from "@/convex/lib/slices/presentationResolution"
import {
  SITE_PRESENTATION_DEFAULTS,
  type SitePresentationDefaults,
  type SitePresentationDefault,
} from "./site-defaults"
import { hasSlicePresentationRenderer } from "./registry"

type Fallback = Extract<SlicePresentationResolution, { status: "fallback" }>
export type RenderPresentationResolution =
  | Exclude<SlicePresentationResolution, Fallback>
  | (Omit<Fallback, "resolvedId"> & { resolvedId: SlicePresentationId })

/**
 * Ordinary owned rendering only: explicit choice, site config, legacy default.
 * Reuse the installed policy for all qualification. Mutation callers continue
 * using their separate resolver and never read this rendering configuration.
 */
export function resolveRenderedSlicePresentation(
  catalog: SlicePresentationCatalog,
  request: { type: string; presentationId?: string },
  defaults: SitePresentationDefaults = SITE_PRESENTATION_DEFAULTS
): RenderPresentationResolution {
  const explicit = resolveSlicePresentation(catalog, {
    ...request,
    intent: "existing",
  })
  // Catalog/Type/malformed-ID refusals cannot be rescued by a site default.
  if (
    explicit.status === "refused" &&
    explicit.reason !== "fallback-unavailable"
  )
    return explicit
  if (request.presentationId !== undefined && explicit.status === "resolved")
    return explicit

  const defaultReads: Readonly<
    Partial<Record<string, SitePresentationDefault>>
  > = defaults
  const configured = Object.hasOwn(defaults, request.type)
    ? defaultReads[request.type]
    : undefined
  if (!configured) return explicit

  let problem: SlicePresentationRefusalReason
  if (configured.typeContractSha256 !== catalog.contractDigests[request.type])
    problem = "contract-incompatible"
  else {
    const selected = resolveSlicePresentation(catalog, {
      type: request.type,
      presentationId: configured.id,
      intent: "existing",
    })
    const presentation = catalog.entries.find(
      (entry) => entry.type === request.type && entry.id === configured.id
    )
    if (
      selected.status === "resolved" &&
      configured.presentationContractSha256 !== presentation?.contractSha256
    ) {
      problem = "contract-incompatible"
    } else if (
      selected.status === "resolved" &&
      selected.newAssignable &&
      hasSlicePresentationRenderer(request.type, selected.resolvedId)
    ) {
      if (request.presentationId === undefined)
        return {
          ...selected,
          requestedId: null,
          legacyDefault: false,
          newAssignable: false,
        }
      return {
        type: request.type,
        requestedId: request.presentationId,
        catalogRevision: catalog.revision,
        status: "fallback",
        resolvedId: selected.resolvedId,
        reason:
          explicit.status === "fallback"
            ? explicit.reason
            : explicit.status === "refused"
              ? (explicit.requestedReason ?? explicit.reason)
              : "presentation-unavailable",
        renderable: true,
        newAssignable: false,
      }
    } else {
      problem =
        selected.status === "resolved"
          ? selected.newAssignable
            ? "presentation-unavailable"
            : "presentation-archived"
          : selected.reason
    }
  }

  // A bad configured choice never changes an explicit occurrence's diagnostic.
  if (request.presentationId !== undefined || explicit.status === "refused")
    return explicit
  return {
    type: request.type,
    requestedId: null,
    catalogRevision: catalog.revision,
    status: "fallback",
    resolvedId: "default",
    reason: problem,
    renderable: true,
    newAssignable: false,
  }
}
