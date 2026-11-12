import { REGISTERED_SLICE_TYPES } from "@/convex/lib/slices"
import {
  readSlicePresentationCatalog,
  slicePresentationCatalogRevision,
  type SlicePresentationCatalog,
} from "@/convex/lib/slices/presentations"

/**
 * Registered-source verification availability only. Authoring and mutation
 * eligibility continue to use the production catalog's installed profile.
 * Keep the real entries and contracts so normal rendering guards still apply.
 */
export async function readRegisteredVerificationCatalog(): Promise<SlicePresentationCatalog> {
  const actual = await readSlicePresentationCatalog()
  const registered = {
    ...actual,
    installedTypes: Object.freeze([...REGISTERED_SLICE_TYPES]),
  }
  return Object.freeze({
    ...registered,
    revision: await slicePresentationCatalogRevision(registered),
  })
}
