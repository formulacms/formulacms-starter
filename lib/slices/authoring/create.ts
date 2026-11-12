import { stat } from "node:fs/promises"
import { join } from "node:path"
import type { SliceSpec } from "./scaffold"
import {
  persistSliceSpec,
  sliceCreationPersistencePaths,
  type PersistedSlice,
} from "./persist"
import { sliceOriginalReferencePaths, sliceReferencePaths } from "./reference"
import { REFERENCE_CONTRACT_PATH } from "./reference-contract"
import { withFileRollback } from "./file-rollback"

export type SliceCreationFinalizer = {
  run: () => unknown | Promise<unknown>
}

export type CreateSliceRecoverablyOptions = {
  root?: string
  rendererBody?: string
  finalizers?: readonly SliceCreationFinalizer[]
  /** Additional root-relative files a finalizer may move, replace, or delete.
   *  Pending original-reference uploads are the primary caller. */
  extraRollbackPaths?: readonly string[]
}

async function existingPath(root: string, path: string): Promise<boolean> {
  try {
    await stat(join(root, path))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

export async function findSliceCreationReferenceConflicts(
  type: string,
  root = process.cwd()
): Promise<string[]> {
  const referencePaths = [
    ...sliceReferencePaths(type),
    ...sliceOriginalReferencePaths(type),
  ]
  const inspected = await Promise.all(
    referencePaths.map(async (path) => ({
      path,
      exists: await existingPath(root, path),
    }))
  )
  return inspected.filter(({ exists }) => exists).map(({ path }) => path)
}

/**
 * Persist and finalize one generated Slice Type as a single recoverable unit.
 *
 * The inner persistence boundary rolls back every descriptor/registration
 * stage. This outer boundary extends the same exact pre-run snapshot across
 * source references and validation gates, so a later failure cannot strand a
 * complete-looking or partial Slice Type.
 */
export async function createSliceRecoverably(
  spec: SliceSpec,
  options: CreateSliceRecoverablyOptions = {}
): Promise<PersistedSlice> {
  const root = options.root ?? process.cwd()
  const rollbackPaths = [
    ...sliceCreationPersistencePaths(spec),
    ...sliceReferencePaths(spec.type),
    ...sliceOriginalReferencePaths(spec.type),
    // The tracked contract is written alongside the reference, so a failed
    // creation must be able to take it back out too.
    REFERENCE_CONTRACT_PATH,
    ...(options.extraRollbackPaths ?? []),
  ]
  const referenceConflicts = await findSliceCreationReferenceConflicts(
    spec.type,
    root
  )
  if (referenceConflicts[0]) {
    throw new Error(`Source reference already exists: ${referenceConflicts[0]}`)
  }

  return withFileRollback(root, rollbackPaths, async () => {
    const persisted = await persistSliceSpec(spec, {
      root,
      rendererBody: options.rendererBody,
    })
    for (const finalizer of options.finalizers ?? []) {
      await finalizer.run()
    }
    return persisted
  })
}
