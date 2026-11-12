export const SOURCE_IMAGE_UPDATED_EVENT = "formulacms:source-image-updated"
export const SNAPSHOT_UPDATED_EVENT = "formulacms:snapshot-updated"
export type SnapshotUpdatedDetail = {
  type: string
  version?: number
  before?: Partial<Record<"desktop" | "mobile", boolean>>
}
export const SNAPSHOT_STALE_EVENT = "formulacms:snapshot-stale"
