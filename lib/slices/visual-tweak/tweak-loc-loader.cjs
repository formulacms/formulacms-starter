/* eslint-disable @typescript-eslint/no-require-imports -- Turbopack loaders execute CommonJS. */
const path = require("node:path")
const { stampTweakLocations } = require("./tweak-loc-stamp.cjs")

module.exports = function tweakLocLoader(source) {
  const root = this.rootContext || process.cwd()
  const file = path.relative(root, this.resourcePath).replaceAll("\\", "/")
  return stampTweakLocations(String(source), file, {
    locations: this.mode !== "production",
  })
}
