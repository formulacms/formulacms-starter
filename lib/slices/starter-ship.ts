// Engine-only "ship to starter" curation list.
//
// Records which slice types the engine owner has approved for distribution to
// `formulacms-starter`. This is a *release-generation input*, not a runtime
// feature and not a per-deployment setting: it lives in a committed JSON file
// under `scripts/starter/**` so the selection is git-reviewable, and that
// subtree is deliberately kept OFF the starter generator's output allowlist
// (ADR-0025) — so it never reaches the generated starter or an agency fork.
//
// Its presence is also the engine-vs-starter signal: `NODE_ENV !== production`
// can't distinguish the two (an agency clones the starter and runs `pnpm dev`
// too), so the admin toggle keys off whether this file resolves at all.
//
// Server-only (`node:fs`). Writes require local development — enforced by the
// calling server action, not here.

import { readFile, writeFile } from "node:fs/promises"
import { assertAuthoringPath, rootFile } from "./authoring/paths"

export const STARTER_SHIP_LIST_PATH = "scripts/starter/ship-list.json"

type ShipListFile = { shipped: string[] }

function shipListPath(root = process.cwd()): string {
  return rootFile(root, STARTER_SHIP_LIST_PATH)
}

/**
 * Read the committed ship-list. Returns the sorted list of ship-marked slice
 * types, or `null` when the file is absent/unreadable — which is the case in a
 * generated starter or an agency fork, and is how callers detect "not the
 * engine repo" so the toggle stays hidden there.
 */
export async function getStarterShipList(
  root = process.cwd()
): Promise<string[] | null> {
  try {
    const raw = await readFile(shipListPath(root), "utf8")
    const parsed = JSON.parse(raw) as Partial<ShipListFile>
    if (!Array.isArray(parsed.shipped)) return []
    return [...parsed.shipped].sort()
  } catch {
    return null
  }
}

/**
 * Add or remove a slice type from the ship-list and persist it (pretty-printed,
 * sorted, deduped). Local-development file write; callers gate on it.
 */
export async function setStarterShipped(
  type: string,
  shipped: boolean,
  root = process.cwd()
): Promise<string[]> {
  const current = (await getStarterShipList(root)) ?? []
  const set = new Set(current)
  if (shipped) set.add(type)
  else set.delete(type)
  const next = [...set].sort()
  assertAuthoringPath(root, shipListPath(root))
  await writeFile(
    shipListPath(root),
    JSON.stringify({ shipped: next }, null, 2) + "\n"
  )
  return next
}

/**
 * Remove a deleted type from the engine-only ship list. Missing files are a
 * supported starter/agency state and stay missing; malformed present files
 * fail closed so deletion rollback can restore the reviewed release input.
 */
export async function removeStarterShippedIfPresent(
  type: string,
  root = process.cwd()
): Promise<{ shipped: string[]; changed: boolean } | null> {
  const path = shipListPath(root)
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }

  const parsed = JSON.parse(raw) as Partial<ShipListFile>
  if (
    !Array.isArray(parsed.shipped) ||
    parsed.shipped.some((storedType) => typeof storedType !== "string")
  ) {
    throw new Error("Invalid starter ship list: expected a string array.")
  }
  const current = [...new Set(parsed.shipped)].sort()
  const shipped = current.filter((storedType) => storedType !== type)
  const changed = shipped.length !== current.length
  if (changed) {
    assertAuthoringPath(root, path)
    await writeFile(path, JSON.stringify({ shipped }, null, 2) + "\n")
  }
  return { shipped, changed }
}
