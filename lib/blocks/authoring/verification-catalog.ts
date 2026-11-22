import { REGISTERED_BLOCK_TYPES } from "@/convex/lib/blocks"
import {
  readBlockPresentationCatalog,
  blockPresentationCatalogRevision,
  type BlockPresentationCatalog,
} from "@/convex/lib/blocks/presentations"

/**
 * Registered-source verification availability only. Authoring and mutation
 * eligibility continue to use the production catalog's installed profile.
 * Keep the real entries and contracts so normal rendering guards still apply.
 */
export async function readRegisteredVerificationCatalog(): Promise<BlockPresentationCatalog> {
  const actual = await readBlockPresentationCatalog()
  const registered = {
    ...actual,
    installedTypes: Object.freeze([...REGISTERED_BLOCK_TYPES]),
  }
  return Object.freeze({
    ...registered,
    revision: await blockPresentationCatalogRevision(registered),
  })
}
