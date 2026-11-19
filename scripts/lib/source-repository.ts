import { statSync } from "node:fs"
import { dirname, join } from "node:path"

/** A file only the formulacms source repository holds; a site cloned or created from the starter never has it. */
export const SOURCE_REPOSITORY_MARKER = "scripts/starter/release.manifest.json"

/**
 * The nearest folder at or above `start` that holds the source-repository
 * marker, or null. `start` must be absolute and already resolved (realpath).
 * Any site qualifies, cloned or created; only the marker counts. Errors other
 * than "not found" propagate, so a caller can refuse on them.
 */
export function findSourceRepositoryAtOrAbove(start: string): string | null {
  for (let ancestor = start; ; ancestor = dirname(ancestor)) {
    try {
      statSync(join(ancestor, SOURCE_REPOSITORY_MARKER))
      return ancestor
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (ancestor === dirname(ancestor)) return null
  }
}
