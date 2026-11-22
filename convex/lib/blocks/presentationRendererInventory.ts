import { REGISTERED_BLOCK_TYPES } from "./index"

// Server-safe owned dispatch inventory. The registry test binds these finite
// choices to the actual React dispatch without importing React into Convex.
const heroRendererIds: readonly string[] = ["default", "centered"]
const defaultRendererTypes: readonly string[] = REGISTERED_BLOCK_TYPES

export function hasOwnedBlockPresentationRenderer(
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
