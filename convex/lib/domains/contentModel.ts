/**
 * Required content-model boundary.
 *
 * This is intentionally a named re-export surface: descriptors, validators,
 * and write-shape helpers remain implemented in their existing modules.
 */
export {
  CONTENT_TYPES,
  contentTypeDefs,
  contentTypeValidator,
  getContentType,
  isActiveContentType,
  REGISTERED_CONTENT_TYPES,
} from "../contentTypes"
export type { ContentType } from "../contentTypes"
export type { ContentTypeDescriptor } from "../contentTypes/types"
export { contentDraftInputValidator } from "../contentTypes/inputShapes"
export {
  buildInitialLocalizedContent,
  copyDescriptorSharedFields,
  descriptorDefaults,
  parseDescriptorSharedFieldPatch,
} from "../contentTypes/writeShapes"
export { SYSTEM_OWNED_SHARED_FIELDS } from "../contentTypes/fieldOwnership"
