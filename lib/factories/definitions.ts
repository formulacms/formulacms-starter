import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { blockDefinitionProblems } from "../../convex/lib/definitions/blocks"
import type { contentTypeDefinitionProblems } from "../../convex/lib/definitions/check"
import { readManifest } from "../blocks/authoring/registration"
import { readContentTypeManifest } from "../content-types/authoring/registration"

/**
 * The definition check of the block and content-type registries under `root`
 * (ADR-0059 amendment (8)), for the factory gate and `content-type:verify`.
 *
 * Each registry runs the check when it loads, so a broken descriptor makes
 * the import throw; that error is returned as a problem, not raised. A
 * registry that loads is checked again with its manifest rows, which is the
 * only place a duplicate manifest row shows. Every module is imported from
 * `root` at run time, so a check of another checkout reads that checkout's
 * files and a load error never stops the caller.
 */

type BlockRegistry = { blockDefs: Parameters<typeof blockDefinitionProblems>[0]["definitions"] }
type BlockCheck = { blockDefinitionProblems: typeof blockDefinitionProblems }
type ContentTypeRegistry = {
  contentTypeDefs: Parameters<typeof contentTypeDefinitionProblems>[0]["definitions"]
  CONTENT_TYPES: readonly string[]
}
type ContentTypeCheck = {
  contentTypeDefinitionProblems: typeof contentTypeDefinitionProblems
}

function load<T>(root: string, path: string): Promise<T> {
  return import(/* @vite-ignore */ pathToFileURL(join(root, path)).href)
}

const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/**
 * One line per problem (a load error keeps its own heading and lines). The
 * registration rows of the gate report an unreadable manifest, so here it
 * only means the duplicate-row rule is skipped.
 */
export async function definitionProblemLines(
  root = process.cwd()
): Promise<string[]> {
  const lines: string[] = []
  try {
    const [{ blockDefs }, { blockDefinitionProblems }] = await Promise.all([
      load<BlockRegistry>(root, "convex/lib/blocks/index.ts"),
      load<BlockCheck>(root, "convex/lib/definitions/blocks.ts"),
    ])
    const entries = await readManifest(root).catch(() => undefined)
    lines.push(
      ...blockDefinitionProblems({ definitions: blockDefs, entries }).map(
        ({ message }) => message
      )
    )
  } catch (error) {
    lines.push(reason(error))
  }
  try {
    const [{ contentTypeDefs, CONTENT_TYPES }, { contentTypeDefinitionProblems }] =
      await Promise.all([
        load<ContentTypeRegistry>(root, "convex/lib/contentTypes/index.ts"),
        load<ContentTypeCheck>(root, "convex/lib/definitions/check.ts"),
      ])
    const entries = await readContentTypeManifest(root).catch(() => undefined)
    lines.push(
      ...contentTypeDefinitionProblems({
        definitions: contentTypeDefs,
        activeTypes: CONTENT_TYPES,
        entries,
      }).map(({ message }) => message)
    )
  } catch (error) {
    lines.push(reason(error))
  }
  return lines
}
