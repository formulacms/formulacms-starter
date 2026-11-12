import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { assertAuthoringPath, rootFile } from "./paths"

type FileSnapshot = {
  path: string
  contents: Buffer | null
}

export class FileRollbackError extends AggregateError {
  readonly operationError: unknown
  readonly rollbackError: unknown

  constructor(operationError: unknown, rollbackError: unknown) {
    super(
      [operationError, rollbackError],
      "Block operation failed and its repository rollback also failed."
    )
    this.name = "FileRollbackError"
    this.operationError = operationError
    this.rollbackError = rollbackError
  }
}

async function snapshotFiles(
  root: string,
  paths: readonly string[]
): Promise<FileSnapshot[]> {
  const targets = [...new Set(paths)].map((path) => ({
    path,
    target: rootFile(root, path),
  }))
  return Promise.all(
    targets.map(async ({ path, target }) => {
      assertAuthoringPath(root, target)
      try {
        return { path, contents: await readFile(target) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { path, contents: null }
        }
        throw error
      }
    })
  )
}

async function restoreFiles(
  root: string,
  snapshots: readonly FileSnapshot[]
): Promise<void> {
  // Check the complete footprint before restoring the first file. Refuse a
  // changed physical destination rather than writing into a foreign target.
  for (const snapshot of snapshots) rootFile(root, snapshot.path)
  for (const snapshot of [...snapshots].reverse()) {
    const target = rootFile(root, snapshot.path)
    if (snapshot.contents === null) {
      try {
        await unlink(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    assertAuthoringPath(root, target)
    await writeFile(target, snapshot.contents)
  }
}

/**
 * Run a bounded repository-file operation with byte-for-byte rollback.
 *
 * Missing files are part of the snapshot, so a failed create removes every
 * artifact it introduced. If restoration itself fails, the combined error
 * preserves both the operation failure and the rollback failure instead of
 * silently claiming recovery.
 */
export async function withFileRollback<T>(
  root: string,
  paths: readonly string[],
  operation: () => Promise<T>
): Promise<T> {
  const snapshots = await snapshotFiles(root, paths)
  try {
    return await operation()
  } catch (error) {
    try {
      await restoreFiles(root, snapshots)
    } catch (rollbackError) {
      throw new FileRollbackError(error, rollbackError)
    }
    // A nested rollback can fail while this wider transaction still restores
    // the complete pre-run snapshot. Preserve the real operation error once
    // the outer recovery has succeeded.
    if (error instanceof FileRollbackError) throw error.operationError
    throw error
  }
}
