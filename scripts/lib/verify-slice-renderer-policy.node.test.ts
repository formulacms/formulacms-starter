import { sliceProfile } from "@/test-utils/slice-profile"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, test } from "vitest"
import { INSTALLED_SLICE_TYPES } from "@/convex/lib/slices"
import { readRegisteredVerificationCatalog } from "@/lib/slices/authoring/verification-catalog"

const fields: Record<string, string> = {
  "contact-form": "primary.body",
  "cta-band": "primary.body",
  "faq-simple": "primary.body",
  "features-icon-grid": "primary.body",
  "hero-agency": "primary.description",
  "hero-with-image": "primary.description",
  "rich-text-body": "primary.body",
  "site-search": "primary.heading",
}
const families = [
  "as-h2",
  "literal-h2-nested",
  "role-heading-aria-level",
] as const
type Family = (typeof families)[number]

function mutate(source: string, field: string, family: Family): string {
  // Select the existing field host in the real renderer, not a synthetic
  // registry replacement. The CLI's lint reads this isolated source copy.
  const host = [
    ...source.matchAll(/<(?:RichText|RichTextContent|Text)\b[\s\S]*?\/>/g),
  ].find(
    ([tag]) =>
      tag.includes(`fieldPath="${field}"`) ||
      tag.includes(`value={${field}}`) ||
      tag.includes(`value={slice.${field}}`)
  )
  if (!host || host.index === undefined)
    throw new Error(`Missing actual host for ${field}`)
  let output: string
  if (family === "as-h2") {
    const withoutAs = host[0].replace(/\bas=(?:"[^"]*"|'[^']*'|\{[^}]*\})/, "")
    output = withoutAs.replace(/\/>$/, 'as="h2" />')
  } else if (family === "literal-h2-nested") {
    output = `<h2><div>{true && <>${host[0]}</>}</div></h2>`
  } else {
    output = `<div role="heading" aria-level={2}><span>${host[0]}</span></div>`
  }
  return (
    source.slice(0, host.index) +
    output +
    source.slice(host.index + host[0].length)
  )
}

async function sourceCli(type: string, relative: string, family?: Family) {
  const root = mkdtempSync(join(tmpdir(), "rf4d-source-policy-"))
  const defaultSource = `components/slices/${type}.tsx`
  const catalog = await readRegisteredVerificationCatalog()
  const sources = new Set([
    defaultSource,
    ...catalog.entries
      .filter((entry) => entry.type === type)
      .map((entry) => entry.rendererSource),
  ])
  for (const source of sources) {
    const target = join(root, source)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(resolve(source), "utf8"))
  }
  const source = readFileSync(resolve(relative), "utf8")
  const target = join(root, relative)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, family ? mutate(source, fields[type]!, family) : source)
  const cli = resolve("scripts/verify-slice.ts")
  // Load the real CLI/modules from the checkout, but make its source reader
  // inspect our isolated source root. Runtime fixture output is unmodified.
  const bootstrap = `process.chdir(${JSON.stringify(root)});
    process.argv = [process.execPath, ${JSON.stringify(cli)}, ${JSON.stringify(type)}, "--no-fidelity"];
    await import(${JSON.stringify(pathToFileURL(cli).href)});`
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", bootstrap],
    {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: resolve("tsconfig.json"),
        SLICE_FIDELITY: "off",
      },
    }
  )
}

for (const profileRow of INSTALLED_SLICE_TYPES.flatMap((type) =>
    families.map((family) => ({ type, family }))
  )) {
  test.each([profileRow])("RF4d source CLI rejects $type $family on a non-title field", sliceProfile([profileRow.type]),
    async ({ type, family }) => {
      const result = await sourceCli(
        type,
        `components/slices/${type}.tsx`,
        family
      )
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(1)
      expect(result.stderr).toContain("renderer heading policy:")
      expect(result.stderr).toContain(fields[type])
    }
  )
}

test.each(
  [
    "components/slices/presentations/hero-with-image-centered.tsx",
    "scripts/starter/overlay/components/slices/hero-with-image.tsx",
  ].filter((relative) => existsSync(resolve(relative)))
)(
  "RF4d source CLI checks declared presentation or overlay %s", sliceProfile(["hero-with-image"]),
  async (relative) => {
    const positive = await sourceCli("hero-with-image", relative)
    expect(positive.error).toBeUndefined()
    expect(positive.status, positive.stderr).toBe(0)
    const result = await sourceCli(
      "hero-with-image",
      relative,
      "literal-h2-nested"
    )
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain("renderer heading policy:")
    expect(result.stderr).toContain(relative)
  }
)
