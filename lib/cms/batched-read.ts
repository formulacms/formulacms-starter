import { ID_BATCH_MAX } from "@/convex/lib/pages/types"

/**
 * Read a record keyed by id in groups the Convex batch reads accept
 * (`ID_BATCH_MAX` ids per call, VISITOR-LIMITS). Calls `readGroup` once per
 * group, all at once, and merges the answers into one record. No ids means no
 * call. Any group failure rejects the whole read, so a caller never receives a
 * partial answer as if it were complete.
 *
 * Pure: no server imports, so client and server callers can share it.
 */
export async function readInIdGroups<TId, TRecord extends object>(
  ids: readonly TId[],
  readGroup: (group: TId[]) => Promise<TRecord>
): Promise<TRecord> {
  const answers = await Promise.all(chunkIds(ids).map(readGroup))
  return mergeGroupAnswers(answers)
}

/** Merge per-group answers (disjoint ids) into one record. */
export function mergeGroupAnswers<TRecord extends object>(
  answers: readonly TRecord[]
): TRecord {
  return Object.assign({}, ...answers) as TRecord
}

/** Split ids into groups no longer than `ID_BATCH_MAX`. */
export function chunkIds<T>(ids: readonly T[], size = ID_BATCH_MAX): T[][] {
  const chunks: T[][] = []
  for (let start = 0; start < ids.length; start += size) {
    chunks.push(ids.slice(start, start + size))
  }
  return chunks
}
