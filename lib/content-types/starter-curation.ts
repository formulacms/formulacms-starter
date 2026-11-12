// Starter override — the engine-only half of Content Type curation is inert here.
//
// In the formulacms engine this module reads and rewrites
// `scripts/starter/curation.json`, the file that decides which Content Types a
// generated starter ships with. That file, the release manifest, the ship list,
// and the validator that checks a proposed selection against the overlay tree
// all live under `scripts/starter/**`, which the release manifest excludes — a
// starter has no curation file to edit and no overlay to validate against.
//
// The engine module guards every path behind `isFormulacmsEngineRoot()`, so the
// code is already dead in a fork. It still imported the validator statically,
// which left the shipped admin surface with an unresolvable import. This
// override keeps the same public API, answers "not available", and drops the
// engine-only dependency.
//
// Curating the Content Types your starter ships with is an engine operation:
// change the selection in the formulacms checkout and regenerate.

import { CONTENT_TYPES, type ContentType } from "@/convex/lib/contentTypes"

export type StarterCurationState =
  | { available: true; contentTypes: string[] }
  | { available: false; reason: string }

export type StarterCurationFileIo = {
  writeFile: (path: string, content: string) => Promise<void>
  rename: (source: string, target: string) => Promise<void>
  unlink: (path: string) => Promise<void>
  suffix: () => string
}

/**
 * Always `null` in a starter: there is no curation file to report on. Callers
 * already treat `null` as "this site cannot curate", the same answer the engine
 * gives outside a formulacms checkout.
 */
export async function getStarterCurationState(
  _engineRoot?: string
): Promise<StarterCurationState | null> {
  return null
}

/**
 * Rejects rather than silently doing nothing — reaching this means a caller
 * skipped the availability check, and a no-op would look like a saved change.
 */
export async function setStarterContentTypeSelection(_options: {
  type: string
  inStarter: boolean
  engineRoot?: string
  io?: StarterCurationFileIo
}): Promise<string[]> {
  throw new Error(
    "Choosing which Content Types a starter ships with happens in the formulacms engine, not in a generated site."
  )
}

export function isActiveContentType(type: string): type is ContentType {
  return (CONTENT_TYPES as readonly string[]).includes(type)
}
