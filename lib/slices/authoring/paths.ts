import { lstatSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

/**
 * Root-relative path resolution for the authoring funnel.
 *
 * Every authoring module writes repo files relative to a `root` that defaults to
 * the process cwd but is overridden to a temp directory by tests and by
 * dry-run previews — so a run against a fixture root can never touch the real
 * repo. Both halves of that convention live here rather than being re-typed per
 * module.
 */

/** The repo root a write is scoped to when the caller doesn't name one. */
export function projectRoot(): string {
  return process.cwd()
}

/** Resolve a repo-relative path (`components/slices/hero.tsx`) against `root`. */
export function rootFile(root: string, file: string): string {
  if (isAbsolute(file))
    throw new Error("Authoring paths must be root-relative.")
  const target = resolve(root, file)
  assertAuthoringPath(root, target)
  return target
}

/** Reject linked/foreign paths, including existing parents of optional files.
 * The selected root may have a platform alias (for example /tmp); descendants
 * may not be symlinks or hard links. External writers must remain quiescent
 * during the short commit; this check does not supply filesystem isolation. */
export function assertAuthoringPath(root: string, absolutePath: string): void {
  const requestedRoot = resolve(root)
  const suffix = relative(requestedRoot, resolve(absolutePath))
  if (
    !suffix ||
    suffix === ".." ||
    suffix.startsWith(`..${sep}`) ||
    isAbsolute(suffix)
  )
    throw new Error("Authoring path escapes the selected application.")
  const physicalRoot = realpathSync(requestedRoot)
  if (!lstatSync(physicalRoot).isDirectory())
    throw new Error("Authoring root must be a directory.")
  const segments = suffix.split(sep)
  let current = physicalRoot
  for (let index = 0; index < segments.length; index++) {
    current = join(current, segments[index]!)
    let entry
    try {
      entry = lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    if (entry.isSymbolicLink() || realpathSync(current) !== current)
      throw new Error("Linked authoring paths are not supported.")
    if (index < segments.length - 1) {
      if (!entry.isDirectory())
        throw new Error("Authoring path parent must be a directory.")
    } else if (!entry.isFile() || entry.nlink !== 1) {
      throw new Error("Authoring paths must be private regular files.")
    }
  }
}

export function assertAuthoringPaths(
  root: string,
  paths: readonly string[]
): void {
  for (const path of paths) assertAuthoringPath(root, path)
}
