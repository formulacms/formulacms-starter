/* eslint-disable @typescript-eslint/no-require-imports -- Turbopack loaders execute CommonJS. */
const { enumerateTweakLocations } = require("./tweak-loc-core.cjs")
const { createHash } = require("node:crypto")

function stampTweakLocations(source, file, { locations = true } = {}) {
  const sourceHash = createHash("sha256").update(source).digest("hex")
  const rendererName = file
    .split("/")
    .at(-1)
    .replace(/\.tsx$/, "")
  const insertions = enumerateTweakLocations(source, file)
    .map((entry) => ({
      offset: entry.insertAttributeAt,
      text: `${locations ? ` data-tweak-loc=${JSON.stringify(entry.loc)} data-tweak-source=${JSON.stringify(sourceHash)}${entry.contentPath ? ` data-tweak-path=${JSON.stringify(entry.contentPath)}` : entry.contentPathExpression ? ` data-tweak-path={${entry.contentPathExpression}}` : ""}` : ""} data-preview-renderer=${JSON.stringify(rendererName)} data-preview-revision=${JSON.stringify(sourceHash)}`,
    }))
    .sort((a, b) => b.offset - a.offset)

  let stamped = source
  for (const insertion of insertions) {
    stamped =
      stamped.slice(0, insertion.offset) +
      insertion.text +
      stamped.slice(insertion.offset)
  }
  return stamped
}

module.exports = { stampTweakLocations }
