import { REGISTERED_SLICE_TYPES } from "./index"

// Server-safe owned dispatch inventory. The registry test binds these finite
// choices to the actual React dispatch without importing React into Convex.
const heroRendererIds: readonly string[] = ["default", "centered"]
const defaultRendererTypes: readonly string[] = REGISTERED_SLICE_TYPES

export function hasOwnedSlicePresentationRenderer(
  type: string,
  id: string
): boolean {
  return (
    defaultRendererTypes.includes(type) &&
    (type === "hero-with-image"
      ? heroRendererIds.includes(id)
      : id === "default")
  )
}
