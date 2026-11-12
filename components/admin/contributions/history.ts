import type { ComponentType } from "react"

import type { Id } from "@/convex/_generated/dataModel"
import type { TitleWriteReport } from "@/convex/lib/richtext/write"

export type HistoryRestoreResult = {
  updatedAt: number
  removedTitleLinks?: TitleWriteReport[]
} & (
  | { locale: string; draftGeneration: number; sharedDraftGeneration: number }
  | { locale?: never }
)

export type SnapshotRestoreExpectations = Readonly<{
  expectedDraftGeneration: number
  expectedSharedDraftGeneration: number
  expectedLifecycleGeneration: number
  expectedPublicGeneration: number
  expectedReleaseGeneration: number
}>

/** Neutral page-editor inputs for core snapshots and the optional M06 slot. */
export type AdminPageHistoryHostProps = Readonly<{
  pageId: Id<"pages">
  /** Current content type for holder-type suffixes in restore notices. */
  pageType?: string
  /** True while the page is edited under Published Snapshot authority. */
  restoreBlocked: boolean
  /** Present under Published Snapshot authority: the language being restored.
   *  Generations are deliberately absent; see `readSnapshotRestore`. */
  snapshotRestore?: Readonly<{ locale: string }>
  /** Reads the restore expectations from the editor's own generation base at
   *  click time. Required under snapshot authority: with no getter, or no
   *  value, the panel sends no restore request. A server prop is never a
   *  source, because another tab's write can advance it. */
  readSnapshotRestore?: () => SnapshotRestoreExpectations | undefined
  restoreDisabled?: boolean
  /** Capture this editor lifetime before starting asynchronous restore work. */
  captureEditorScope?: () => () => boolean
  /** Capture submitted identity before confirmation; success reconciles even if feedback expires. */
  captureRestoreReconciliation?: () => (result: HistoryRestoreResult) => void
  onSnapshotRestored?: (result: {
    locale: string
    draftGeneration: number
    sharedDraftGeneration: number
    removedTitleLinks?: TitleWriteReport[]
  }) => void
  /** Called after a revision became the page's draft. */
  onRestored: (
    updatedAt: number,
    removedTitleLinks?: TitleWriteReport[]
  ) => void
}>

export type AdminHistoryBrowserBinding = Readonly<{
  PanelSlot: ComponentType<AdminPageHistoryHostProps>
}>

/** Community installs no M06 participant. Keep this a literal empty binding. */
export const ADMIN_HISTORY_BROWSER_BINDING: AdminHistoryBrowserBinding | null =
  null
