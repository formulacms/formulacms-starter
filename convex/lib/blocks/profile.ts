import { ConvexError } from "convex/values"
import { INSTALLED_BLOCK_TYPES } from "."

export type BlockContentLocation = {
  locale: string
  index: number
  path: string
  type: string
}

type LocalizedBlockContent = { blocks?: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/** Find every stored block whose code is outside the static installed profile. */
export function findUnavailableBlockLocations(
  content: unknown,
  allowedTypes: readonly string[] = INSTALLED_BLOCK_TYPES
): BlockContentLocation[] {
  if (!isRecord(content)) return []
  const allowed = new Set(allowedTypes)
  const locations: BlockContentLocation[] = []
  for (const [locale, value] of Object.entries(content)) {
    if (!isRecord(value)) continue
    const blocks = (value as LocalizedBlockContent).blocks
    if (!Array.isArray(blocks)) continue
    for (const [index, block] of blocks.entries()) {
      const type =
        isRecord(block) && typeof block.type === "string"
          ? block.type
          : "<missing-type>"
      if (!allowed.has(type)) {
        locations.push({
          locale,
          index,
          path: `content.${locale}.blocks[${index}]`,
          type,
        })
      }
    }
  }
  return locations
}

export function formatBlockProfileBlocker(
  operation: string,
  locations: readonly BlockContentLocation[]
): string {
  const details = locations
    .map(({ path, type }) => `${path} (type "${type}")`)
    .join(", ")
  return `Cannot ${operation} content because installed block code is unavailable at ${details}.`
}

/**
 * Reject one operation against both stored and submitted content. Checking
 * both bags prevents a save from hiding a disabled stored block by replacing
 * its locale key before the profile guard runs.
 */
export function assertBlockProfileContent(
  operation: string,
  contents: readonly unknown[],
  allowedTypes: readonly string[] = INSTALLED_BLOCK_TYPES
): void {
  const locations = contents.flatMap((content) =>
    findUnavailableBlockLocations(content, allowedTypes)
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
    throw new ConvexError(formatBlockProfileBlocker(operation, uniqueLocations))
  }
}

export function assertInstalledBlockContent(
  operation: string,
  content: unknown
): void {
  assertBlockProfileContent(operation, [content])
}
