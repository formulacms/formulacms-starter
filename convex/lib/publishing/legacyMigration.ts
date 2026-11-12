/**
 * Mechanism-2 overlay seam (FR2.0 rev1 §3.2). A fresh installation starts in
 * snapshot authority and must never re-enter the legacy phase, so the starter
 * ships without the legacy Published Snapshot migration.
 */
export const LEGACY_SNAPSHOT_MIGRATION_INSTALLED: boolean = false
