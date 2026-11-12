// ADR-0025 §2 — engine schema marker stamped on every record the engine writes
// and read by future migrations to detect compatibility.
// Plan 035 Unit D adds the dynamic-list menu variant and its recent-page index.
export const SCHEMA_VERSION = 4
