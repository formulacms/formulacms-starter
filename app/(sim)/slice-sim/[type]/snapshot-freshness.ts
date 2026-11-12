import { stat } from "node:fs/promises"

export async function isComparisonSnapshotStale(
  sourceFiles: string[],
  snapshotFile: string
): Promise<boolean> {
  try {
    const [snapshot, ...sources] = await Promise.all([
      stat(snapshotFile),
      ...sourceFiles.map((file) => stat(file)),
    ])
    if (!snapshot.isFile()) return false
    return sources.some(
      (source) => source.isFile() && source.mtimeMs > snapshot.mtimeMs
    )
  } catch {
    // A missing capture is unavailable, not stale. Missing source evidence also
    // cannot truthfully establish that an existing capture is out of date.
    return false
  }
}
