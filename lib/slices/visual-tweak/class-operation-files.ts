import {
  mkdir,
  open,
  readFile,
  rename as renameFile,
  stat,
  unlink,
} from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import {
  applyClassOperationBatch,
  hashTweakSource,
  type ClassTweakDiff,
  type ClassTweakOperation,
} from "./class-operations"

type Rename = (from: string, to: string) => Promise<void>

type FileOperationFailure = {
  ok: false
  code: string
  error: string
  targets?: string[]
}

export type ApplyClassOperationFileResult =
  | {
      ok: true
      applied: number
      file: string
      checkpointId: string
      sourceHash: string
      diffs: ClassTweakDiff[]
    }
  | FileOperationFailure

export type UndoClassOperationCheckpointResult =
  { ok: true; file: string; sourceHash: string } | FileOperationFailure

type Checkpoint = {
  version: 1
  id: string
  type: string
  file: string
  beforeSource: string
  beforeHash: string
  afterHash: string
  createdAt: number
}

const rendererLocks = new Map<string, Promise<void>>()

function rendererFile(type: string): string {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(type)) {
    throw new Error(`Invalid slice type: ${type}`)
  }
  return `components/slices/${type}.tsx`
}

function checkpointPath(
  root: string,
  type: string,
  checkpointId: string
): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      checkpointId
    )
  ) {
    throw new Error("Invalid visual tweak checkpoint id.")
  }
  return join(
    root,
    ".nextcms",
    "visual-tweak-checkpoints",
    type,
    `${checkpointId}.json`
  )
}

async function writeSyncedFile(
  path: string,
  source: string,
  mode?: number
): Promise<void> {
  const handle = await open(path, "wx", mode)
  try {
    await handle.writeFile(source, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

async function withRendererLock<T>(
  key: string,
  run: () => Promise<T>
): Promise<T> {
  const previous = rendererLocks.get(key) ?? Promise.resolve()
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => held)
  rendererLocks.set(key, tail)
  await previous
  try {
    return await run()
  } finally {
    release()
    if (rendererLocks.get(key) === tail) rendererLocks.delete(key)
  }
}

export async function applyClassOperationFileBatch(
  {
    root,
    type,
    operations,
  }: {
    root: string
    type: string
    operations: ClassTweakOperation[]
  },
  dependencies: { rename?: Rename } = {}
): Promise<ApplyClassOperationFileResult> {
  let file: string
  try {
    file = rendererFile(type)
  } catch (error) {
    return { ok: false, code: "invalid-operation", error: String(error) }
  }
  const absolute = join(root, file)
  return withRendererLock(absolute, async () => {
    let source: string
    try {
      source = await readFile(absolute, "utf8")
    } catch (error) {
      return { ok: false, code: "read-failed", error: String(error) }
    }
    if (
      operations.some((operation) => !operation.target.startsWith(`${file}:`))
    ) {
      return {
        ok: false,
        code: "invalid-operation",
        error: `Every operation must target ${file}.`,
      }
    }
    const candidate = applyClassOperationBatch({ source, file, operations })
    if (!candidate.ok) return candidate
    if (candidate.source === source) {
      return {
        ok: false,
        code: "no-change",
        error: "No source change to save.",
      }
    }

    const id = randomUUID()
    const checkpoint = checkpointPath(root, type, id)
    const checkpointDir = dirname(checkpoint)
    const temporary = join(
      dirname(absolute),
      `.${type}.formulacms-tweak-${id}.tmp`
    )
    const beforeHash = hashTweakSource(source)
    const afterHash = hashTweakSource(candidate.source)
    const record: Checkpoint = {
      version: 1,
      id,
      type,
      file,
      beforeSource: source,
      beforeHash,
      afterHash,
      createdAt: Date.now(),
    }

    try {
      await mkdir(checkpointDir, { recursive: true })
      await writeSyncedFile(checkpoint, `${JSON.stringify(record)}\n`)
      const mode = (await stat(absolute)).mode
      await writeSyncedFile(temporary, candidate.source, mode)

      const current = await readFile(absolute, "utf8")
      if (hashTweakSource(current) !== beforeHash) {
        await Promise.all([
          removeIfPresent(temporary),
          removeIfPresent(checkpoint),
        ])
        return {
          ok: false,
          code: "hash-mismatch",
          error: "The renderer changed while this batch was being promoted.",
        }
      }
      await (dependencies.rename ?? renameFile)(temporary, absolute)
    } catch (error) {
      await Promise.all([
        removeIfPresent(temporary),
        removeIfPresent(checkpoint),
      ])
      return {
        ok: false,
        code: "promotion-failed",
        error: error instanceof Error ? error.message : String(error),
      }
    }

    return {
      ok: true,
      applied: candidate.applied,
      file,
      checkpointId: id,
      sourceHash: afterHash,
      diffs: candidate.diffs,
    }
  })
}

function isCheckpoint(value: unknown): value is Checkpoint {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<Checkpoint>
  return (
    record.version === 1 &&
    typeof record.id === "string" &&
    typeof record.type === "string" &&
    typeof record.file === "string" &&
    typeof record.beforeSource === "string" &&
    typeof record.beforeHash === "string" &&
    typeof record.afterHash === "string" &&
    typeof record.createdAt === "number"
  )
}

export async function undoClassOperationCheckpoint(
  {
    root,
    type,
    checkpointId,
  }: { root: string; type: string; checkpointId: string },
  dependencies: { rename?: Rename } = {}
): Promise<UndoClassOperationCheckpointResult> {
  let file: string
  let checkpoint: string
  try {
    file = rendererFile(type)
    checkpoint = checkpointPath(root, type, checkpointId)
  } catch (error) {
    return { ok: false, code: "invalid-checkpoint", error: String(error) }
  }
  const absolute = join(root, file)
  return withRendererLock(absolute, async () => {
    let record: Checkpoint
    try {
      const parsed: unknown = JSON.parse(await readFile(checkpoint, "utf8"))
      if (!isCheckpoint(parsed))
        throw new Error("Malformed visual tweak checkpoint.")
      record = parsed
    } catch (error) {
      return { ok: false, code: "checkpoint-missing", error: String(error) }
    }
    if (
      record.id !== checkpointId ||
      record.type !== type ||
      record.file !== file ||
      hashTweakSource(record.beforeSource) !== record.beforeHash
    ) {
      return {
        ok: false,
        code: "invalid-checkpoint",
        error: "The visual tweak checkpoint does not match this renderer.",
      }
    }
    let current: string
    try {
      current = await readFile(absolute, "utf8")
    } catch (error) {
      return { ok: false, code: "read-failed", error: String(error) }
    }
    if (hashTweakSource(current) !== record.afterHash) {
      return {
        ok: false,
        code: "hash-mismatch",
        error:
          "The renderer changed after Save, so this checkpoint cannot be restored safely.",
      }
    }

    const temporary = join(
      dirname(absolute),
      `.${type}.formulacms-undo-${checkpointId}.tmp`
    )
    try {
      const mode = (await stat(absolute)).mode
      await writeSyncedFile(temporary, record.beforeSource, mode)
      const latest = await readFile(absolute, "utf8")
      if (hashTweakSource(latest) !== record.afterHash) {
        await removeIfPresent(temporary)
        return {
          ok: false,
          code: "hash-mismatch",
          error:
            "The renderer changed while Undo was being prepared, so the saved source was kept.",
        }
      }
      await (dependencies.rename ?? renameFile)(temporary, absolute)
      await removeIfPresent(checkpoint)
    } catch (error) {
      await removeIfPresent(temporary)
      return {
        ok: false,
        code: "promotion-failed",
        error: error instanceof Error ? error.message : String(error),
      }
    }
    return { ok: true, file, sourceHash: record.beforeHash }
  })
}
