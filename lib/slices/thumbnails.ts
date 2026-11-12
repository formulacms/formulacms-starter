import { join } from "node:path"

/**
 * Single source of truth for slice-simulator thumbnail paths. Both the public
 * URL and the on-disk location are derived here so callers never re-spell the
 * `/slice-sim/<type>[.mobile].png` template (it lived in three places before).
 *
 * - current desktop → `<type>.png`
 * - current mobile  → `<type>.mobile.png`
 * - before desktop  → `<type>.before.png`
 * - before mobile   → `<type>.mobile.before.png`
 */
export type ThumbnailVariant = "desktop" | "mobile"
export type ThumbnailSlot = "current" | "before"

const PUBLIC_SUBDIR = "slice-sim"

export function thumbnailFilename(
  type: string,
  variant: ThumbnailVariant = "desktop",
  slot: ThumbnailSlot = "current"
): string {
  if (slot === "before") {
    return variant === "mobile"
      ? `${type}.mobile.before.png`
      : `${type}.before.png`
  }
  return variant === "mobile" ? `${type}.mobile.png` : `${type}.png`
}

/** Public URL for a slice thumbnail, e.g. `/slice-sim/hero.png`. Pure string —
 * safe to call anywhere (no Node built-ins touched). */
export function thumbnailUrl(
  type: string,
  variant: ThumbnailVariant = "desktop",
  slot: ThumbnailSlot = "current"
): string {
  return `/${PUBLIC_SUBDIR}/${thumbnailFilename(type, variant, slot)}`
}

/** Full-page comparison snapshots are separate from the fixed 16:9 catalog
 * thumbnail above. Before/After and manual source comparison need the whole
 * render at the simulator viewport width; one artifact cannot serve both jobs. */
export function comparisonSnapshotFilename(
  type: string,
  variant: ThumbnailVariant = "desktop",
  slot: ThumbnailSlot = "current"
): string {
  const scope =
    variant === "mobile" ? `${type}.mobile.full` : `${type}.full`
  return slot === "before" ? `${scope}.before.png` : `${scope}.png`
}

/** Public URL for a full-page comparison snapshot. Pure string. */
export function comparisonSnapshotUrl(
  type: string,
  variant: ThumbnailVariant = "desktop",
  slot: ThumbnailSlot = "current"
): string {
  return `/${PUBLIC_SUBDIR}/${comparisonSnapshotFilename(type, variant, slot)}`
}

/** Absolute path to a full-page comparison snapshot under `public/`.
 * Server-only. */
export function comparisonSnapshotFile(
  type: string,
  variant: ThumbnailVariant = "desktop",
  slot: ThumbnailSlot = "current"
): string {
  return join(
    process["cwd"](),
    "public",
    PUBLIC_SUBDIR,
    comparisonSnapshotFilename(type, variant, slot)
  )
}

/** Absolute path to the thumbnail under `public/`. Server-only (uses
 * `process.cwd()`). */
export function thumbnailFile(
  type: string,
  variant: ThumbnailVariant = "desktop",
  slot: ThumbnailSlot = "current"
): string {
  return join(
    process["cwd"](),
    "public",
    PUBLIC_SUBDIR,
    thumbnailFilename(type, variant, slot)
  )
}

/** Both the public URL and the absolute file path for one thumbnail. Callers
 * keep their own existence checks but stop re-spelling the template. */
export function thumbnail(
  type: string,
  variant: ThumbnailVariant = "desktop",
  slot: ThumbnailSlot = "current"
): { url: string; file: string } {
  return {
    url: thumbnailUrl(type, variant, slot),
    file: thumbnailFile(type, variant, slot),
  }
}
