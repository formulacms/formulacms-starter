import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readdir, readFile, unlink } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { rootFile } from "../../blocks/authoring/paths"
import { writeFileAtomically } from "../../factories/atomic-write"
import { withFileRollback } from "../../factories/file-rollback"
import { LOCAL_STATE_DIRECTORY } from "../../local-state/directory"

/**
 * The recovery record of `pnpm content-type:new` (ADR-0059 amendment (8)).
 *
 * Before its first write, the command records each planned file: its path,
 * its bytes before the run (or that it was absent) and the sha256 of the
 * bytes the command will write. A run that ends normally deletes the record.
 * A run that stops part way leaves it, so the next run, `pnpm check:factories`
 * and `pnpm content-type:new -- --recover` can see it.
 *
 * Recovery undoes only bytes this command wrote. A file that changed after
 * the interrupted run is kept as it is and named, and the record stays.
 *
 * Prior art: git keeps `.git/MERGE_HEAD` until `git merge --abort` or a
 * commit resolves the merge, and refuses a new merge until then.
 */

/** Machine-local and git-ignored (`/.formulacms/local/`). */
export const CREATION_RECORD_PATH = join(
  LOCAL_STATE_DIRECTORY,
  "content-type-new.pending.json"
)
export const RECOVER_COMMAND = "pnpm content-type:new -- --recover"

type PriorBytes = "absent" | { encoding: "utf8" | "base64"; content: string }

export type CreationRecordFile = {
  path: string
  prior: PriorBytes
  writtenSha256: string
}

export type CreationRecord = {
  type: string
  startedAt: string
  files: CreationRecordFile[]
}

export type RecoveryResult = {
  type: string
  restored: string[]
  kept: string[]
  /** Leftover `writeFileAtomically` temp files deleted beside recorded paths. */
  temporaryFilesRemoved: number
}

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex")

// Text files stay readable in the record; other bytes are kept exactly.
function encodePrior(bytes: Buffer | null): PriorBytes {
  if (bytes === null) return "absent"
  const text = bytes.toString("utf8")
  return Buffer.from(text, "utf8").equals(bytes)
    ? { encoding: "utf8", content: text }
    : { encoding: "base64", content: bytes.toString("base64") }
}

function decodePrior(prior: PriorBytes): Buffer | null {
  return prior === "absent" ? null : Buffer.from(prior.content, prior.encoding)
}

async function readBytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Delete the temp files `temporaryPathFor` (lib/factories/atomic-write.ts)
 * names for `target`: exactly `.<basename>.<uuid>.tmp` in the same folder.
 * Returns how many were deleted.
 */
async function removeTemporarySiblings(target: string): Promise<number> {
  const folder = dirname(target)
  const pattern = new RegExp(
    `^\\.${escapeRegExp(basename(target))}\\.${UUID_PATTERN}\\.tmp$`
  )
  let names: string[]
  try {
    names = await readdir(folder)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0
    throw error
  }
  let removed = 0
  for (const name of names) {
    if (!pattern.test(name)) continue
    try {
      await unlink(join(folder, name))
      removed += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return removed
}

function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
  return left === null || right === null ? left === right : left.equals(right)
}

export function hasCreationRecord(root = process.cwd()): boolean {
  return existsSync(join(root, CREATION_RECORD_PATH))
}

function isRecord(value: unknown): value is CreationRecord {
  const record = value as CreationRecord | null
  return (
    typeof record?.type === "string" &&
    Array.isArray(record.files) &&
    record.files.every(
      (file) =>
        typeof file?.path === "string" &&
        typeof file.writtenSha256 === "string" &&
        (file.prior === "absent" ||
          (typeof file.prior?.content === "string" &&
            (file.prior.encoding === "utf8" ||
              file.prior.encoding === "base64")))
    )
  )
}

export async function readCreationRecord(
  root = process.cwd()
): Promise<CreationRecord | null> {
  const bytes = await readBytes(join(root, CREATION_RECORD_PATH))
  if (bytes === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString("utf8"))
  } catch {
    parsed = undefined
  }
  if (!isRecord(parsed)) {
    throw new Error(
      `${CREATION_RECORD_PATH} is not a valid content-type creation record. Restore the files it names by hand, then delete it.`
    )
  }
  return parsed
}

/** The refusal text while a record exists. */
export function pendingCreationMessage(type?: string): string {
  const what = type ? `content type "${type}"` : "a content type"
  return [
    `An earlier pnpm content-type:new run for ${what} did not finish. Its record is ${CREATION_RECORD_PATH}.`,
    `Run ${RECOVER_COMMAND} to remove the half-created type, then run the command again.`,
  ].join("\n")
}

/**
 * Apply the recovery table to every file in the record:
 * - equal to its prior bytes (or still absent): nothing to do;
 * - equal to the bytes the command wrote: restore the prior bytes (delete the
 *   file when it was absent);
 * - anything else: keep it untouched and name it.
 * The record is deleted only when no file is kept. Returns null when there is
 * no record.
 */
export async function recoverContentTypeCreation(
  root = process.cwd()
): Promise<RecoveryResult | null> {
  const record = await readCreationRecord(root)
  if (!record) return null
  const result: RecoveryResult = {
    type: record.type,
    restored: [],
    kept: [],
    temporaryFilesRemoved: 0,
  }
  for (const file of record.files) {
    const target = rootFile(root, file.path)
    result.temporaryFilesRemoved += await removeTemporarySiblings(target)
    const current = await readBytes(target)
    const prior = decodePrior(file.prior)
    if (sameBytes(current, prior)) continue
    if (current !== null && sha256(current) === file.writtenSha256) {
      if (prior === null) await unlink(target)
      else await writeFileAtomically(target, prior)
      result.restored.push(file.path)
    } else {
      result.kept.push(file.path)
    }
  }
  if (result.kept.length === 0) await unlink(join(root, CREATION_RECORD_PATH))
  return result
}

/** The terminal text of a recovery, and whether every file was resolved. */
export function recoveryReport(result: RecoveryResult): {
  ok: boolean
  text: string
} {
  const temporary = result.temporaryFilesRemoved
  const temporaryText =
    temporary > 0
      ? ` Removed ${temporary} leftover temporary ${temporary === 1 ? "file" : "files"}.`
      : ""
  if (result.kept.length === 0) {
    const count = result.restored.length
    return {
      ok: true,
      text: `Removed the half-created content type "${result.type}" (${count} ${count === 1 ? "file" : "files"} restored).${temporaryText} You can run pnpm content-type:new again.`,
    }
  }
  return {
    ok: false,
    text: [
      `Could not remove the half-created content type "${result.type}" completely.${temporaryText}`,
      ...result.kept.map(
        (path) => `  ${path} (changed after the interrupted run)`
      ),
      `These files were kept as they are. Their bytes from before the run are in ${CREATION_RECORD_PATH}.`,
      `Resolve these files, then run ${RECOVER_COMMAND} again.`,
    ].join("\n"),
  }
}

/** A creation that failed; `recovery` tells what was undone. */
export class ContentTypeCreationError extends Error {
  readonly operationError: unknown
  readonly recovery: RecoveryResult | null
  readonly recoveryError: unknown

  constructor(
    operationError: unknown,
    recovery: RecoveryResult | null,
    recoveryError?: unknown
  ) {
    super(
      operationError instanceof Error
        ? operationError.message
        : String(operationError)
    )
    this.name = "ContentTypeCreationError"
    this.operationError = operationError
    this.recovery = recovery
    this.recoveryError = recoveryError
  }
}

export type CreationWriteOptions = {
  /**
   * Called after each file write with the count written so far. Returning
   * true stops the run there and leaves the record and the written files, as
   * a process that dies would (a test seam).
   */
  afterWrite?: (written: number) => boolean | void
}

/**
 * Write the planned files under a recovery record. Refuses while a record
 * exists. On a thrown error, `withFileRollback` restores the files, then the
 * recovery table runs, so the record goes only when every file is back to
 * its prior state.
 */
export async function writeFilesUnderCreationRecord(
  root: string,
  plan: { type: string; files: readonly { path: string; content: string }[] },
  options: CreationWriteOptions = {}
): Promise<{ interrupted: boolean }> {
  if (hasCreationRecord(root)) {
    throw new Error(
      pendingCreationMessage((await readCreationRecord(root))?.type)
    )
  }
  const files = await Promise.all(
    plan.files.map(async ({ path, content }) => {
      const bytes = Buffer.from(content, "utf8")
      return {
        path,
        bytes,
        entry: {
          path,
          prior: encodePrior(await readBytes(rootFile(root, path))),
          writtenSha256: sha256(bytes),
        },
      }
    })
  )
  const record: CreationRecord = {
    type: plan.type,
    startedAt: new Date().toISOString(),
    files: files.map(({ entry }) => entry),
  }
  await writeFileAtomically(
    rootFile(root, CREATION_RECORD_PATH),
    Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8")
  )

  let interrupted = false
  try {
    await withFileRollback(
      root,
      files.map(({ path }) => path),
      async () => {
        for (const [index, { path, bytes }] of files.entries()) {
          await writeFileAtomically(rootFile(root, path), bytes)
          if (options.afterWrite?.(index + 1)) {
            interrupted = true
            return
          }
        }
      }
    )
  } catch (error) {
    let recovery: RecoveryResult | null = null
    let recoveryError: unknown
    try {
      recovery = await recoverContentTypeCreation(root)
    } catch (caught) {
      recoveryError = caught
    }
    throw new ContentTypeCreationError(error, recovery, recoveryError)
  }
  if (!interrupted) await unlink(join(root, CREATION_RECORD_PATH))
  return { interrupted }
}
