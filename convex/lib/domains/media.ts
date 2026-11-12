/** Required media boundary; implementation remains in focused media helpers. */
export {
  assertMediaSoftDeleteAllowed,
  assertMediaUnreferenced,
  formatUsageForError,
  getMediaUsage,
  type MediaUsage,
} from "../media/usage"
export { clearPageReferences, refreshPageReferences } from "../pageReferences"
export {
  ImageDimensionsError,
  readImageDimensions,
} from "../media/imageDimensions"
export type { ImageDimensionsErrorCode } from "../media/imageDimensions"
