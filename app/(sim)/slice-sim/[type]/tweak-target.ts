import { createHash } from "node:crypto"
import { enumerateTweakLocations } from "@/lib/slices/visual-tweak/tweak-loc-core.cjs"
export type TweakTargetMetadata = {
  loc: string
  /** JSX traversal path is invariant under class-only edits; source columns are not. */
  sourcePath?: string
  tag: string
  sourceHash: string
  sourceClassTokens: string[]
  editable: boolean
  templateWide: boolean
}
export function tweakTargetsForSource(
  source: string,
  file: string
): TweakTargetMetadata[] {
  const sourceHash = createHash("sha256").update(source).digest("hex")
  return enumerateTweakLocations(source, file).map((entry, index) => {
    const literals =
      entry.className.kind === "literal"
        ? [entry.className.literal]
        : entry.className.kind === "cn"
          ? entry.className.literals
          : []
    return {
      loc: entry.loc,
      sourcePath: `jsx.${index}`,
      tag: entry.tag,
      sourceHash,
      sourceClassTokens: literals.flatMap((literal) =>
        literal.value.trim() ? literal.value.trim().split(/\s+/) : []
      ),
      editable: entry.className.kind !== "unsupported",
      templateWide: entry.templateWide,
    }
  })
}
