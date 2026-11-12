import { ConvexError } from "convex/values"
import { INSTALLED_SLICE_TYPES } from "."

export type SliceContentLocation = {
  locale: string
  index: number
  path: string
  type: string
}

type LocalizedSliceContent = { slices?: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** Find every stored slice whose code is outside the static installed profile. */
export function findUnavailableSliceLocations(
  content: unknown,
  allowedTypes: readonly string[] = INSTALLED_SLICE_TYPES
): SliceContentLocation[] {
  if (!isRecord(content)) return []
  const allowed = new Set(allowedTypes)
  const locations: SliceContentLocation[] = []
  for (const [locale, value] of Object.entries(content)) {
    if (!isRecord(value)) continue
    const slices = (value as LocalizedSliceContent).slices
    if (!Array.isArray(slices)) continue
    for (const [index, slice] of slices.entries()) {
      const type =
        isRecord(slice) && typeof slice.type === "string"
          ? slice.type
          : "<missing-type>"
      if (!allowed.has(type)) {
        locations.push({
          locale,
          index,
          path: `content.${locale}.slices[${index}]`,
          type,
        })
      }
    }
  }
  return locations
}

export function formatSliceProfileBlocker(
  operation: string,
  locations: readonly SliceContentLocation[]
): string {
  const details = locations
    .map(({ path, type }) => `${path} (type "${type}")`)
    .join(", ")
  return `Cannot ${operation} content because installed block code is unavailable at ${details}.`
}

/**
 * Reject one operation against both stored and submitted content. Checking
 * both bags prevents a save from hiding a disabled stored slice by replacing
 * its locale key before the profile guard runs.
 */
export function assertSliceProfileContent(
  operation: string,
  contents: readonly unknown[],
  allowedTypes: readonly string[] = INSTALLED_SLICE_TYPES
): void {
  const locations = contents.flatMap((content) =>
    findUnavailableSliceLocations(content, allowedTypes)
  )
  const uniqueLocations = [
    ...new Map(
      locations.map((location) => [
        `${location.path}\u0000${location.type}`,
        location,
      ])
    ).values(),
  ]
  if (uniqueLocations.length > 0) {
    throw new ConvexError(formatSliceProfileBlocker(operation, uniqueLocations))
  }
}

export function assertInstalledSliceContent(
  operation: string,
  content: unknown
): void {
  assertSliceProfileContent(operation, [content])
}
