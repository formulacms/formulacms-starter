import { readFile, writeFile } from "node:fs/promises"

/**
 * Block-registration emitter (ADR-0021). `lib/blocks/blocks.manifest.json` is
 * the single source of truth for the registered block set + picker metadata;
 * the export/import/validator-union/`blockDefs` blocks in
 * `convex/lib/blocks/index.ts`, the lucide import + `BLOCK_METADATA` in
 * `lib/blocks/builder.ts`, and the renderer imports + `BLOCK_COMPONENTS` in
 * `components/blocks/block-registry.tsx`, the query-scoped simulator
 * registry, and its ambient module declarations are *projected* from it.
 *
 * Registering a block = append a manifest entry + regenerate. Deleting =
 * drop the entry + regenerate. Updating metadata = edit the entry + regenerate.
 * This replaces the per-arm regex surgery (and its inverse removers) that the
 * persist path used to apply to those three files: each generated region is now
 * rebuilt wholesale from a pure render function, so there is no whitespace- or
 * quote-sensitive marker to miss and no remove-then-re-add dance.
 *
 * The output deliberately reproduces the prior patch-writer's style (trailing
 * commas in the `v.union(...)` arms, 2-space indent, no semicolons). It does NOT
 * run Prettier: the union's trailing comma is not `es5`-Prettier output, so a
 * format pass would fight the committed shape and the round-trip tests.
 */

import { toCamel, toPascal } from "./naming"
import { assertAuthoringPath, projectRoot, rootFile } from "./paths"

/** Mirrors the `BlockOrigin` union in lib/blocks/builder.ts. */
export type BlockOrigin = "system" | "user"

export type BlockManifestEntry = {
  type: string
  label: string
  description: string
  icon: string
  group: string
  /** Absent ⇒ "system" (a shipped reference block); the scaffolder stamps
   *  "user" on blocks authored on this site. */
  origin?: BlockOrigin
  /** False keeps the descriptor readable but removes it from authoring. */
  selected?: boolean
}

export type BlockRegistration = BlockManifestEntry & {
  /** Resolved installed-code selection; absent in the manifest means true. */
  selected: boolean
  /** camelCase descriptor name, e.g. "heroAgency" (and its file stem). */
  camel: string
  /** PascalCase, e.g. "HeroAgency" (renderer export + `*Block` type prefix). */
  pascal: string
  /** index.ts descriptor module specifier (camelCase file). */
  descriptorModule: string
  /** block-list renderer module specifier (kebab-case file). */
  rendererModule: string
  /** Exported renderer component name. */
  componentName: string
}

export type RegistrationFile =
  "index" | "builder" | "blockRegistry" | "blockSim" | "tweakLocTypes"

export const MANIFEST_PATH = "lib/blocks/blocks.manifest.json"
const INDEX_PATH = "convex/lib/blocks/index.ts"
const BUILDER_PATH = "lib/blocks/builder.ts"
const BLOCK_REGISTRY_PATH = "components/blocks/block-registry.tsx"
const BLOCK_SIM_PATH = "components/blocks/block-sim-registry.tsx"
const TWEAK_LOC_TYPES_PATH = "components/blocks/tweak-loc-modules.d.ts"

const FILE_PATHS: Record<RegistrationFile, string> = {
  index: INDEX_PATH,
  builder: BUILDER_PATH,
  blockRegistry: BLOCK_REGISTRY_PATH,
  blockSim: BLOCK_SIM_PATH,
  tweakLocTypes: TWEAK_LOC_TYPES_PATH,
}

const ALL_FILES: RegistrationFile[] = [
  "index",
  "builder",
  "blockRegistry",
  "blockSim",
  "tweakLocTypes",
]

export function toRegistration(entry: BlockManifestEntry): BlockRegistration {
  const camel = toCamel(entry.type)
  const pascal = toPascal(entry.type)
  return {
    ...entry,
    selected: entry.selected !== false,
    camel,
    pascal,
    descriptorModule: `./${camel}`,
    rendererModule: `./${entry.type}`,
    componentName: pascal,
  }
}

export function manifestToRegistrations(
  entries: readonly BlockManifestEntry[]
): BlockRegistration[] {
  return entries.map(toRegistration)
}

export type BlockCodeProfile = {
  /** Every descriptor still known to the readable storage/public profile. */
  registered: BlockRegistration[]
  /** The statically installed authoring/simulator profile. */
  installed: BlockRegistration[]
  /** Registered descriptors intentionally disabled from authoring. */
  disabled: BlockRegistration[]
}

/**
 * Compose the one static block profile used by generation and release
 * projections. `selected` on a manifest entry is the default installed set;
 * a release may pass an explicit list to project a smaller starter without
 * mutating the source manifest. There is deliberately no module-state read
 * or runtime registry mutation here.
 */
export function composeBlockProfile(
  entries: readonly BlockManifestEntry[],
  installedTypes?: readonly string[]
): BlockCodeProfile {
  const registered = manifestToRegistrations(entries)
  const registeredByType = new Map(
    registered.map((entry) => [entry.type, entry])
  )
  if (registeredByType.size !== registered.length) {
    throw new Error("Block manifest contains duplicate types.")
  }

  const installed = installedTypes
    ? installedTypes.map((type) => {
        const entry = registeredByType.get(type)
        if (!entry)
          throw new Error(`Installed block is not registered: ${type}`)
        return { ...entry, selected: true }
      })
    : registered.filter((entry) => entry.selected)
  const installedTypesSet = new Set(installed.map((entry) => entry.type))
  if (installedTypesSet.size !== installed.length) {
    throw new Error("Block profile contains duplicate installed types.")
  }
  return {
    registered,
    installed,
    disabled: registered.filter((entry) => !installedTypesSet.has(entry.type)),
  }
}

// ── manifest IO ─────────────────────────────────────────────────────────────

/**
 * The single authority on what a manifest entry is. Exported because the
 * starter release path reads the same file from two roots synchronously and
 * cannot go through `readManifest` (async, one fixed path) — see
 * `blockCandidateTypes` in scripts/starter/release-lib.ts.
 */
export function isManifestEntry(value: unknown): value is BlockManifestEntry {
  if (!value || typeof value !== "object") return false
  const e = value as Record<string, unknown>
  return (
    typeof e.type === "string" &&
    typeof e.label === "string" &&
    typeof e.description === "string" &&
    typeof e.icon === "string" &&
    typeof e.group === "string" &&
    (e.origin === undefined || e.origin === "system" || e.origin === "user") &&
    (e.selected === undefined || typeof e.selected === "boolean")
  )
}

/** Keep persisted key order stable so re-serialization is diff-free. */
function normalizeEntry(e: BlockManifestEntry): BlockManifestEntry {
  return {
    type: e.type,
    label: e.label,
    description: e.description,
    icon: e.icon,
    group: e.group,
    // Only carry `origin` when set, so shipped entries stay `origin`-free.
    ...(e.origin ? { origin: e.origin } : {}),
    // Only carry the opt-out; the default installed profile stays diff-free.
    ...(e.selected === false ? { selected: false } : {}),
  }
}

export async function readManifest(
  root = projectRoot()
): Promise<BlockManifestEntry[]> {
  const raw = await readFile(rootFile(root, MANIFEST_PATH), "utf8")
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || !parsed.every(isManifestEntry)) {
    throw new Error(`${MANIFEST_PATH} is not a valid block manifest.`)
  }
  return parsed.map(normalizeEntry)
}

function serializeManifest(entries: BlockManifestEntry[]): string {
  return `${JSON.stringify(entries.map(normalizeEntry), null, 2)}\n`
}

async function writeIfChanged(
  root: string,
  path: string,
  next: string
): Promise<boolean> {
  let current: string | undefined
  try {
    current = await readFile(path, "utf8")
  } catch {
    current = undefined
  }
  if (current === next) return false
  assertAuthoringPath(root, path)
  await writeFile(path, next)
  return true
}

/** Returns true when the manifest file's content actually changed. */
export async function writeManifest(
  root: string,
  entries: BlockManifestEntry[]
): Promise<boolean> {
  return writeIfChanged(
    root,
    rootFile(root, MANIFEST_PATH),
    serializeManifest(entries)
  )
}

// ── region renderers (pure) ─────────────────────────────────────────────────

export function renderBlockExports(regs: BlockRegistration[]): string {
  return regs
    .map(
      (r) =>
        `export { ${r.camel}Def, ${r.camel}Block } from "${r.descriptorModule}"\n` +
        `export type { ${r.pascal}Block } from "${r.descriptorModule}"`
    )
    .join("\n\n")
}

export function renderBlockImports(regs: BlockRegistration[]): string {
  return [
    'import { withBlockOccurrencePresentation } from "./occurrencePresentation"',
    ...regs.map((r) => `import { ${r.camel}Def } from "${r.descriptorModule}"`),
  ].join("\n")
}

export function renderBlockValidator(regs: BlockRegistration[]): string {
  const arms = regs
    .map((r) => `  withBlockOccurrencePresentation(${r.camel}Def.validator),`)
    .join("\n")
  return `export const blockValidator = v.union(\n${arms}\n)`
}

export function renderInstalledBlockValidator(
  regs: BlockRegistration[]
): string {
  const selected = regs.filter((r) => r.selected)
  const arms = selected
    .map((r) => `  withBlockOccurrencePresentation(${r.camel}Def.validator),`)
    .join("\n")
  return `export const installedBlockValidator = v.union(\n${arms}\n)`
}

export function renderBlockDefs(regs: BlockRegistration[]): string {
  const entries = regs.map((r) => `  "${r.type}": ${r.camel}Def,`).join("\n")
  return `export const blockDefs = {\n${entries}\n} as const`
}

export function renderInstalledBlockDefs(regs: BlockRegistration[]): string {
  const entries = regs
    .filter((r) => r.selected)
    .map((r) => `  "${r.type}": ${r.camel}Def,`)
    .join("\n")
  return `export const installedBlockDefs = {\n${entries}\n} as const`
}

export function renderLucideImport(regs: BlockRegistration[]): string {
  const icons = [...new Set(regs.map((r) => r.icon))].sort()
  const lines = icons.map((icon) => `  ${icon},`).join("\n")
  return `import {\n${lines}\n  type LucideIcon,\n} from "lucide-react"`
}

export function renderBlockMetadata(regs: BlockRegistration[]): string {
  const entries = regs
    .map(
      (r) =>
        `  "${r.type}": {\n` +
        `    label: ${JSON.stringify(r.label)},\n` +
        `    description: ${JSON.stringify(r.description)},\n` +
        `    icon: ${r.icon},\n` +
        `    group: ${JSON.stringify(r.group)},\n` +
        `    origin: ${JSON.stringify(r.origin ?? "system")},\n` +
        `  },`
    )
    .join("\n")
  return (
    "export const BLOCK_METADATA: Partial<Record<RegisteredBlockType, BlockMetadata>> &\n" +
    "  Record<BlockType, BlockMetadata> = {\n" +
    `${entries}\n}`
  )
}

export function renderRendererImports(regs: BlockRegistration[]): string {
  return regs
    .map((r) => `import { ${r.componentName} } from "${r.rendererModule}"`)
    .join("\n")
}

export function renderSimulatorRendererImports(
  regs: BlockRegistration[]
): string {
  return regs
    .filter((r) => r.selected)
    .map(
      (r) =>
        `import { ${r.componentName} } from "@/components/blocks/${r.type}?tweak-loc"`
    )
    .join("\n")
}

export function renderBlockComponents(regs: BlockRegistration[]): string {
  const entries = regs
    .map(
      (r) =>
        `  "${r.type}": (block, ctx) => <${r.componentName} block={block} ctx={ctx} />,`
    )
    .join("\n")
  return (
    `export const BLOCK_COMPONENTS = {\n${entries}\n} satisfies {\n` +
    `  [T in Block["type"]]: (\n` +
    `    block: Extract<Block, { type: T }>,\n` +
    `    ctx: BlockRenderContext\n` +
    `  ) => React.ReactNode\n}`
  )
}

export function renderSimulatorBlockComponents(
  regs: BlockRegistration[]
): string {
  return renderBlockComponents(regs.filter((r) => r.selected))
    .replace(
      "export const BLOCK_COMPONENTS",
      "export const BLOCK_SIM_COMPONENTS"
    )
    .replaceAll('Block["type"]', 'InstalledBlock["type"]')
    .replaceAll("Extract<Block,", "Extract<InstalledBlock,")
}

export function renderTweakLocModuleDeclarations(
  regs: BlockRegistration[]
): string {
  return regs
    .filter((r) => r.selected)
    .map(
      (r) =>
        `declare module "@/components/blocks/${r.type}?tweak-loc" {\n` +
        `  export { ${r.componentName} } from "@/components/blocks/${r.type}"\n` +
        `}`
    )
    .join("\n")
}

const REGION_RENDERERS: Record<
  RegistrationFile,
  Array<[string, (regs: BlockRegistration[]) => string]>
> = {
  index: [
    ["block-exports", renderBlockExports],
    ["block-imports", renderBlockImports],
    ["block-validator", renderBlockValidator],
    ["block-defs", renderBlockDefs],
    ["block-installed-validator", renderInstalledBlockValidator],
    ["block-installed-defs", renderInstalledBlockDefs],
  ],
  builder: [
    [
      "block-icons",
      (regs) => renderLucideImport(regs.filter((r) => r.selected)),
    ],
    [
      "block-metadata",
      (regs) => renderBlockMetadata(regs.filter((r) => r.selected)),
    ],
  ],
  blockRegistry: [
    ["block-renderer-imports", renderRendererImports],
    ["block-components", renderBlockComponents],
  ],
  blockSim: [
    [
      "block-sim-renderer-imports",
      (regs) => renderSimulatorRendererImports(regs.filter((r) => r.selected)),
    ],
    [
      "block-sim-components",
      (regs) => renderSimulatorBlockComponents(regs.filter((r) => r.selected)),
    ],
  ],
  tweakLocTypes: [
    [
      "tweak-loc-modules",
      (regs) =>
        renderTweakLocModuleDeclarations(regs.filter((r) => r.selected)),
    ],
  ],
}

// ── region replacement ───────────────────────────────────────────────────────

/** Replace the body between the `// @block-codegen:<name>:start` and `:end`
 *  marker lines with `body`. The markers are matched literally — one substring
 *  search each, no whitespace-sensitive regex. */
function replaceRegion(source: string, name: string, body: string): string {
  const start = `// @block-codegen:${name}:start`
  const end = `// @block-codegen:${name}:end`
  const startIdx = source.indexOf(start)
  const endIdx = source.indexOf(end)
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(`Missing @block-codegen region "${name}".`)
  }
  const before = source.slice(0, startIdx + start.length)
  const after = source.slice(endIdx)
  return `${before}\n${body}\n${after}`
}

export function renderRegistrationFile(
  file: RegistrationFile,
  current: string,
  regs: BlockRegistration[]
): string {
  let next = current
  for (const [name, render] of REGION_RENDERERS[file]) {
    next = replaceRegion(next, name, render(regs))
  }
  return next
}

/**
 * Regenerate the generated regions of the registration projection files from `regs`.
 * Writes (and reports) only the files whose content actually changed, so a
 * metadata-only edit touches `builder.ts` alone. Returns changed paths in the
 * canonical index → builder → block-list order.
 */
export async function syncRegistration(
  regs: BlockRegistration[],
  opts: {
    root?: string
    only?: RegistrationFile[]
    dryRun?: boolean
    afterWrite?: (file: RegistrationFile, path: string) => void | Promise<void>
  } = {}
): Promise<{ files: string[] }> {
  const root = opts.root ?? projectRoot()
  const targets = opts.only ?? ALL_FILES
  const targetSet = new Set(targets)
  const changed: string[] = []
  // The three registration files share no data, so read them together. The
  // write pass below stays sequential and ordered — `afterWrite` reports
  // persistence stages in the canonical index → builder → block-list order.
  const sources = new Map(
    (
      await Promise.all(
        ALL_FILES.filter((file) => targetSet.has(file)).map(async (file) => {
          try {
            return [
              file,
              await readFile(rootFile(root, FILE_PATHS[file]), "utf8"),
            ] as const
          } catch (error) {
            // Tools-absent created applications intentionally omit the simulator
            // projections. Older narrow fixtures also predate these files.
            // Regenerate them only where the selected application retains them.
            if (
              (file === "blockSim" || file === "tweakLocTypes") &&
              (error as NodeJS.ErrnoException).code === "ENOENT"
            ) {
              return null
            }
            throw error
          }
        })
      )
    ).filter(
      (entry): entry is readonly [RegistrationFile, string] => entry !== null
    )
  )
  for (const file of ALL_FILES) {
    if (!targetSet.has(file)) continue
    if (!sources.has(file)) continue
    const relPath = FILE_PATHS[file]
    const absPath = rootFile(root, relPath)
    const current = sources.get(file)!
    const next = renderRegistrationFile(file, current, regs)
    if (next !== current) {
      if (!opts.dryRun) {
        assertAuthoringPath(root, absPath)
        await writeFile(absPath, next)
        await opts.afterWrite?.(file, relPath)
      }
      changed.push(relPath)
    }
  }
  return { files: changed }
}
