import { randomUUID } from "node:crypto"
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

// The machine-local folder formulacms keeps beside the checkout (gitignored):
// block reference originals, undo checkpoints, design-system transactions,
// the AI tool choice, the local model cache and the bootstrap hand-off.
// It is `.formulacms/local/`: `.formulacms/` itself holds the creation records
// create-formulacms-app writes, which stay tracked. Sites from release 0.2.0
// and earlier have local state in `.nextcms/`. That folder is moved when the
// dev or production server starts (`instrumentation.ts`), unless a formulacms
// command-line tool is running; until then, everything reads and writes it in
// place (ADR-0048 amendment, 2026-11-16).
const FORMULACMS_DIRECTORY = ".formulacms"
export const LOCAL_STATE_DIRECTORY = join(FORMULACMS_DIRECTORY, "local")
export const LEGACY_LOCAL_STATE_DIRECTORY = ".nextcms"

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function hasEntries(path: string): boolean {
  try {
    return readdirSync(path).length > 0
  } catch (error) {
    // Missing means empty; anything else is unknown, so count it as busy.
    return (error as NodeJS.ErrnoException).code !== "ENOENT"
  }
}

/** The local state folder, for reads and writes alike. Never touches disk:
 *  only the server-start move renames the old folder. */
export function localStateDirectory(root: string): string {
  const current = join(root, LOCAL_STATE_DIRECTORY)
  if (exists(current)) return current
  const legacy = join(root, LEGACY_LOCAL_STATE_DIRECTORY)
  return exists(legacy) ? legacy : current
}

const IN_USE_DIRECTORY = "in-use"

/** Marks the old `.nextcms/` folder as in use by this process, so the
 *  server-start move waits. Command-line tools that write local state call it
 *  first. Writes nothing when the folder is not the old one. Never throws.
 *  Returns the release function, also registered for process exit. */
export function markLocalStateInUse(root: string): () => void {
  const legacy = join(root, LEGACY_LOCAL_STATE_DIRECTORY)
  if (localStateDirectory(root) !== legacy) return () => {}
  const marker = join(
    legacy,
    IN_USE_DIRECTORY,
    `${process.pid}-${randomUUID()}`
  )
  try {
    // Not recursive: a folder that has just moved must never be re-created.
    try {
      mkdirSync(join(legacy, IN_USE_DIRECTORY))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    writeFileSync(marker, "")
  } catch {
    return () => {}
  }
  const release = () => {
    try {
      unlinkSync(marker)
    } catch {
      // Already gone.
    }
  }
  process.once("exit", release)
  return release
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function inUseByLiveProcess(
  legacy: string,
  isAlive: (pid: number) => boolean
): boolean {
  let names: string[]
  try {
    names = readdirSync(join(legacy, IN_USE_DIRECTORY))
  } catch {
    return false
  }
  return names.some((name) => {
    const pid = Number(/^(\d+)-/.exec(name)?.[1])
    // Unparsable or dead entries stay in place and are ignored.
    return Number.isSafeInteger(pid) && pid > 0 && isAlive(pid)
  })
}

/** Moves an idle old `.nextcms/` folder to `.formulacms/local/`. Called
 *  once, from `register()` in `instrumentation.ts`, before the server takes
 *  requests. Leaves the folder in place while a design-system transaction is
 *  open in it or a running command-line tool has marked it in use. Never
 *  throws. */
export function moveLegacyLocalState(
  root: string,
  rename: (from: string, to: string) => void = renameSync,
  isAlive: (pid: number) => boolean = processIsAlive
): void {
  const legacy = join(root, LEGACY_LOCAL_STATE_DIRECTORY)
  try {
    // Renaming onto an existing empty folder succeeds on POSIX: never try it.
    if (exists(join(root, LOCAL_STATE_DIRECTORY))) return
    if (!lstatSync(legacy, { throwIfNoEntry: false })?.isDirectory()) return
    const parent = join(root, FORMULACMS_DIRECTORY)
    const parentInfo = lstatSync(parent, { throwIfNoEntry: false })
    if (parentInfo && !parentInfo.isDirectory()) return
    const transactions = join(legacy, "design-system-transactions")
    if (
      exists(join(transactions, "lock")) ||
      hasEntries(join(transactions, "active")) ||
      hasEntries(join(transactions, "preparing"))
    ) {
      return
    }
    // A CLI that started before the server keeps its resolved paths.
    if (inUseByLiveProcess(legacy, isAlive)) return
    // The creation records may already have made the parent; an empty parent
    // left by a failed rename is harmless.
    if (!parentInfo) {
      try {
        mkdirSync(parent)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
    }
    rename(legacy, join(root, LOCAL_STATE_DIRECTORY))
  } catch {
    // Cross-device root, permissions, a concurrent move: keep the old folder.
  }
}

/** True for a root-relative path inside `.formulacms/` (creation records and
 *  local state) or `.nextcms/`, or either folder itself. A save plan must
 *  never name one. */
export function isLocalStatePath(relativePath: string): boolean {
  return [FORMULACMS_DIRECTORY, LEGACY_LOCAL_STATE_DIRECTORY].some(
    (name) => relativePath === name || relativePath.startsWith(`${name}/`)
  )
}
