import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

/** A reviewed model update depends on its descriptor, renderer and registration
 * inputs. Shared registration changes conservatively require a fresh review.
 * This is an optimistic source precondition, not an external-writer lock. */
export async function readBlockModelSourceRevision(
  type: string,
  root = process.cwd()
): Promise<string> {
  if (
    typeof type !== "string" ||
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.exec(type)?.[0] !== type
  ) {
    throw new Error("Invalid Block Type")
  }
  const camel = type.replace(/-([a-z])/g, (_, char: string) =>
    char.toUpperCase()
  )
  const paths = [
    `convex/lib/blocks/${camel}.ts`,
    `components/blocks/${type}.tsx`,
    "lib/blocks/builder.ts",
    "lib/blocks/blocks.manifest.json",
  ]
  const contents = await Promise.all(
    paths.map((path) => readFile(join(root, path)))
  )
  return createHash("sha256")
    .update(
      JSON.stringify([
        type,
        ...contents.map((content) => content.toString("hex")),
      ])
    )
    .digest("hex")
}
