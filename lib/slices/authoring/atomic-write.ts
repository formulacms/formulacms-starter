/**
 * Crash-safe single-file writer (slice-fidelity plan §5 B2, "Single-file
 * durability"). A reader of the target always observes either the complete
 * previous file or the complete new one — never a half-written reference
 * image, preserved original, or contract file.
 *
 * This is deliberately *not* the multi-file recovery boundary. `withFileRollback`
 * in `file-rollback.ts` remains that outer boundary; this module only makes each
 * individual file replacement indivisible.
 */
import { open, mkdir, rename, unlink } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { basename, dirname, join } from "node:path"

/**
 * The staging path for one write. It is a sibling of the target so the final
 * rename stays within a single filesystem, which is what makes it atomic; a
 * temp directory elsewhere would silently degrade into a copy.
 */
export function temporaryPathFor(target: string): string {
  return join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
}

async function discard(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

/**
 * Write `contents` to `target` indivisibly: stage beside the target, flush the
 * bytes to disk, then rename onto the target. A failure at any step removes the
 * staged file and leaves the existing target byte-for-byte unchanged.
 */
export async function writeFileAtomically(
  target: string,
  contents: Buffer
): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const staged = temporaryPathFor(target)
  try {
    const handle = await open(staged, "wx")
    try {
      await handle.writeFile(contents)
      // Durability before rename: an unsynced temp file can survive the rename
      // as zero bytes across a crash, which is the failure this module exists
      // to prevent.
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(staged, target)
  } catch (error) {
    await discard(staged)
    throw error
  }
}
