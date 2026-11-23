// ADR-0025 §2 — engine schema marker stamped on every record the engine writes
// and read by future migrations to detect compatibility.
// Release 0.3.0 (schema version 5): per-language page fields, the removed team tables and the new purge and AI model tables.
// Release 0.3.1 keeps schema version 5: it only adds the optional pagePurges.startedAt field.
// Release 0.4.0 (schema version 6): stored tables, fields and indexes are renamed to block names, for example the blockOccurrence* tables and the page field blocks.
// Release 0.5.1 (schema version 7): retired page-wide publication, migration, membership, entitlement and role tables are removed. Fresh installs only.
export const SCHEMA_VERSION = 7

// The other per-write stamp: edit-time tokens (`updatedAt`) compared by equality.
/**
 * Next value for an edit-time token (`updatedAt`) that callers compare by
 * equality ("edited since I read it?").
 *
 * Convex fixes `Date.now()` at the start of a mutation, so two writes in the
 * same millisecond would leave the token unchanged and a stale check could
 * pass. This returns a value strictly after the stored one. `previous` must be
 * the row's value read in the same mutation, never the caller's expected value.
 */
export function nextUpdatedAt(previous: number | undefined, now: number): number {
  return previous === undefined ? now : Math.max(now, previous + 1)
}
