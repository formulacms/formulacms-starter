import type { ThumbnailVariant } from "@/lib/slices/thumbnails"

export type SnapshotPair = Record<ThumbnailVariant, string | null>

export type SnapshotState = {
  current: SnapshotPair
  before: SnapshotPair
  stale: Record<ThumbnailVariant, boolean>
}

export function markSnapshotsStale(state: SnapshotState): SnapshotState {
  return {
    ...state,
    stale: {
      desktop: Boolean(state.current.desktop),
      mobile: Boolean(state.current.mobile),
    },
  }
}

export function markSnapshotsFresh(state: SnapshotState): SnapshotState {
  return { ...state, stale: { desktop: false, mobile: false } }
}
