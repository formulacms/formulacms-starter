// ADR-0025 §2 — engine schema marker stamped on every record the engine writes
// and read by future migrations to detect compatibility.
// Release 0.3.0 (schema version 5): per-language page fields, the removed team tables and the new purge and AI model tables.
export const SCHEMA_VERSION = 5

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
