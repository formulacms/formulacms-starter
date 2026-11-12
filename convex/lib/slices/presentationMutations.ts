import { ConvexError } from "convex/values"
import { hasValidSliceOccurrencePresentation } from "./occurrencePresentation"
import {
  resolveSlicePresentation,
  type SlicePresentationCatalog,
  type SlicePresentationRefusalReason,
  type SlicePresentationResolution,
} from "./presentationResolution"

type Occurrence = {
  locale: string
  index: number
  path: string
  value: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function occurrences(content: unknown): Occurrence[] {
  if (!isRecord(content)) return []
  return Object.entries(content).flatMap(([locale, localized]) => {
    if (!isRecord(localized) || !Array.isArray(localized.slices)) return []
    return localized.slices.map((value: unknown, index: number) => ({
      locale,
      index,
      path: `content.${locale}.slices[${index}]`,
      value: isRecord(value) ? value : {},
    }))
  })
}

/** Legacy bags need no source-catalog read; malformed explicit values do. */
export function hasExplicitSlicePresentations(
  contents: readonly unknown[]
): boolean {
  return contents.some((content) =>
    occurrences(content).some(
      ({ value }) => value.presentationIdV1 !== undefined
    )
  )
}

export type SlicePresentationMutationOptions = {
  content?: unknown
  existingContent?: unknown
  /** Trusted server operation, never an author-supplied historical intent. */
  operation?: string
  expectedPresentationCatalogRevision?: string
}

type OccurrenceDecision = {
  locale: string
  index: number
  path: string
  intent: "new-assignment" | "existing" | "historical"
  resolution: SlicePresentationResolution
}

export type SlicePresentationMutationDecision =
  | { status: "allowed"; occurrences: readonly OccurrenceDecision[] }
  | {
      status: "refused"
      bag: "existing" | "incoming"
      path: string
      reason: SlicePresentationRefusalReason
      resolution?: SlicePresentationResolution
    }

/**
 * Pure whole-content policy against a trusted installed-source catalog.
 * This never rewrites content or inserts legacy defaults. Native storage and
 * unchanged Type descriptors remain responsible for body validation; callers
 * still own authentication, Type archival and transaction boundaries.
 */
export function decideSlicePresentationMutation(
  catalog: SlicePresentationCatalog,
  options: SlicePresentationMutationOptions
): SlicePresentationMutationDecision {
  const before = occurrences(options.existingContent)
  const after = occurrences(options.content)
  for (const [bag, values] of [
    ["existing", before],
    ["incoming", after],
  ] as const) {
    for (const occurrence of values) {
      if (!hasValidSliceOccurrencePresentation(occurrence.value)) {
        return {
          status: "refused",
          bag,
          path: occurrence.path,
          reason: "invalid-presentation-id",
        }
      }
      if (!catalog.installedTypes.includes(String(occurrence.value.type))) {
        return {
          status: "refused",
          bag,
          path: occurrence.path,
          reason: "type-unavailable",
        }
      }
    }
  }

  const decisions: OccurrenceDecision[] = []
  for (const occurrence of after) {
    const { value } = occurrence
    const presentationId = value.presentationIdV1 as string | undefined
    const retained = before.some(
      (previous) =>
        previous.locale === occurrence.locale &&
        previous.value.id === value.id &&
        previous.value.type === value.type &&
        previous.value.presentationIdV1 === presentationId
    )
    const removesExplicitChoice = before.some(
      (previous) =>
        previous.locale === occurrence.locale &&
        previous.value.id === value.id &&
        previous.value.type === value.type &&
        previous.value.presentationIdV1 !== undefined &&
        presentationId === undefined
    )
    const intent =
      options.operation === "restore"
        ? "historical"
        : retained || (presentationId === undefined && !removesExplicitChoice)
          ? "existing"
          : "new-assignment"
    const resolution = resolveSlicePresentation(
      catalog,
      intent === "new-assignment"
        ? {
            type: String(value.type),
            presentationId,
            intent,
            // Missing revision deliberately fails the resolver's equality check.
            expectedCatalogRevision:
              options.expectedPresentationCatalogRevision ?? "",
          }
        : { type: String(value.type), presentationId, intent }
    )
    if (resolution.status === "refused") {
      return {
        status: "refused",
        bag: "incoming",
        path: occurrence.path,
        reason: resolution.reason,
        resolution,
      }
    }
    decisions.push({
      locale: occurrence.locale,
      index: occurrence.index,
      path: occurrence.path,
      intent,
      resolution,
    })
  }
  return { status: "allowed", occurrences: decisions }
}

export function assertSlicePresentationMutation(
  catalog: SlicePresentationCatalog,
  options: SlicePresentationMutationOptions
): void {
  const decision = decideSlicePresentationMutation(catalog, options)
  if (decision.status === "refused") {
    throw new ConvexError(
      `Cannot ${options.operation ?? "edit"} content because Block presentation ${decision.reason} at ${decision.bag} ${decision.path}.`
    )
  }
}
