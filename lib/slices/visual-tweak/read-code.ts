import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { INSTALLED_SLICE_TYPES } from "@/convex/lib/slices"
import { enumerateTweakLocations } from "./tweak-loc-core.cjs"

export type CodeTarget = { loc: string; tag: string; sourceHash: string }
export type SliceCodeFile = { path: string; source: string; digest: string }
export type SliceCodeSnapshot = {
  type: string
  renderer: SliceCodeFile
  css: SliceCodeFile
  locations: Array<{ loc: string; tag: string; line: number; column: number }>
}
export type SliceCodeResult =
  | { ok: true; snapshot: SliceCodeSnapshot }
  | { ok: false; code: string; error: string }

class InspectionRefusal extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/** Fixed source paths only. An opened file is bounded and checked before/after read. */
async function readFixedFile(
  root: string,
  relative: string,
  maxBytes: number
): Promise<SliceCodeFile> {
  const parts = relative.split("/")
  let current = root
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const info = await lstat(current)
    if (
      info.isSymbolicLink() ||
      (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())
    )
      throw new InspectionRefusal(
        "unsafe-source",
        `Source inspection refuses linked or non-regular paths: ${relative}.`
      )
  }
  if ((await realpath(current)) !== current)
    throw new InspectionRefusal(
      "unsafe-source",
      "Source path changed during inspection."
    )
  const file = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > maxBytes)
      throw new InspectionRefusal(
        "source-too-large",
        `Source exceeds the inspection limit: ${relative}.`
      )
    const bytes = Buffer.alloc(maxBytes + 1)
    let size = 0
    while (size < bytes.length) {
      const next = await file.read(bytes, size, bytes.length - size, size)
      if (!next.bytesRead) break
      size += next.bytesRead
    }
    const after = await file.stat()
    const visible = await lstat(current)
    if (size > maxBytes)
      throw new InspectionRefusal(
        "source-too-large",
        `Source exceeds the inspection limit: ${relative}.`
      )
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      size !== after.size ||
      visible.isSymbolicLink() ||
      visible.dev !== after.dev ||
      visible.ino !== after.ino ||
      (await realpath(current)) !== current
    )
      throw new InspectionRefusal(
        "source-changed",
        "Source changed while it was being inspected. Read it again."
      )
    const content = bytes.subarray(0, size)
    const source = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(content)
    return {
      path: relative,
      source,
      digest: createHash("sha256").update(content).digest("hex"),
    }
  } finally {
    await file.close()
  }
}

/** Internal checkout root is supplied by the server, never by a browser request. */
export async function readRegisteredSliceCode({
  root,
  type,
  target,
}: {
  root: string
  type: string
  target?: CodeTarget | null
}): Promise<SliceCodeResult> {
  try {
    if (
      typeof type !== "string" ||
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(type) ||
      !(INSTALLED_SLICE_TYPES as readonly string[]).includes(type)
    )
      throw new InspectionRefusal(
        "unregistered-type",
        "Only a registered Block Type can be inspected."
      )
    if (
      target &&
      (typeof target.loc !== "string" ||
        typeof target.tag !== "string" ||
        typeof target.sourceHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(target.sourceHash))
    )
      throw new InspectionRefusal(
        "invalid-target",
        "The selected source target is invalid."
      )
    const checkout = await realpath(root)
    const [renderer, css] = await Promise.all([
      readFixedFile(checkout, `components/slices/${type}.tsx`, 128 * 1024),
      readFixedFile(checkout, "app/globals.css", 512 * 1024),
    ])
    const locations = enumerateTweakLocations(
      renderer.source,
      renderer.path
    ).map(({ loc, tag, line, column }) => ({ loc, tag, line, column }))
    if (target) {
      if (target.sourceHash !== renderer.digest)
        throw new InspectionRefusal(
          "source-stale",
          "The renderer changed since this target was selected. Select a current target and inspect it again."
        )
      if (
        !locations.some(
          (entry) => entry.loc === target.loc && entry.tag === target.tag
        )
      )
        throw new InspectionRefusal(
          "target-stale",
          "The selected source location is absent. No replacement target was selected."
        )
    }
    return { ok: true, snapshot: { type, renderer, css, locations } }
  } catch (error) {
    return {
      ok: false,
      code: error instanceof InspectionRefusal ? error.code : "read-failed",
      error:
        error instanceof InspectionRefusal
          ? error.message
          : "The registered source files could not be inspected.",
    }
  }
}
