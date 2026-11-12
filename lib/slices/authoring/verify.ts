import { readSliceDefinition } from "@/convex/lib/slices"
import { readSlice } from "@/convex/lib/slices/identity"
import {
  resolvePageOutline,
  SLICE_OUTLINE_DESCRIPTORS,
  validateOutlineDescriptor,
} from "@/lib/slices/page-outline"
import { readFileSync } from "node:fs"
// @starter-projection:hero-presentations:start
import { HERO_PRESENTATION_DEFINITIONS } from "@/convex/lib/slices/heroPresentationDefinitions"
// @starter-projection:hero-presentations:end
import { mkdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { validate } from "convex-helpers/validators"
import {
  sliceDefs,
  sliceValidator,
  type Primitive,
  type Slice,
} from "@/convex/lib/slices"
import { validateSlicesRichText } from "@/convex/lib/slices/validate"
import { SliceZone } from "@/components/slices/slice-zone"
import { hasRenderer } from "@/components/slices/slice-zone-registry"
import {
  createSampleRelationCards,
  createSampleSlice,
  hasCuratedPreview,
} from "@/lib/slices/sample"
import type { SliceRenderContext } from "@/lib/slices/links"
import { walkDef } from "@/convex/lib/slices/walk"
import { primaryListFields } from "@/convex/lib/slices/repeating"
import { resolveFieldContract } from "@/convex/lib/richtext/contracts"
import { validateStrict } from "@/convex/lib/richtext/strict"
import { isPageType } from "@/convex/lib/pages/types"
import { EDITABLE_FIELD_KINDS } from "@/components/admin/fields/editable-kinds"
import { getSliceReference } from "@/lib/slices/authoring/reference"
import {
  inspectRendererRoot,
  type RendererRootInspection,
} from "@/lib/design-system/inventory"
import {
  checkReferenceIntegrity,
  pngDimensions,
  TALL_ASPECT_LIMIT,
} from "@/lib/slices/authoring/reference-integrity"
import {
  loadReferenceContractFile,
  referenceContractKey,
  REFERENCE_CONTRACT_PATH,
  REFERENCE_VARIANTS,
} from "@/lib/slices/authoring/reference-contract"
import {
  evaluateDomContract,
  readDomMeasurements,
} from "@/lib/slices/authoring/dom-geometry"
import { computeVisualDiff } from "@/lib/slices/authoring/visual-diff"
import {
  validateContractRendererHeadings,
  type RendererFieldContractResolution,
  type RendererHeadingFieldAccess,
} from "./renderer-heading-rule"
import {
  lintRendererSourceTextWithHeadingResolver,
  type RendererSourceLintResult,
} from "./renderer-source-lint"
import { toPascal } from "./naming"
import { validateRendererBindings } from "./renderer-binding-rule"
import { verifyFieldCoverage } from "./verify-coverage"
import { readRegisteredVerificationCatalog } from "./verification-catalog"
import { COVERAGE_MIGRATION_PENDING } from "./field-coverage"
export { lintRendererSourceText } from "./renderer-source-lint"

/**
 * `verify-slice` — the objective gate the slice-authoring agent's verify-loop
 * calls (ADR-0016, Phase 2 M1), and the backstop human PR review sits on top of.
 *
 * It reuses Phase 1 end to end: synthesize a believable sample for the type, then
 * assert it (1) parses the slice union, (2) passes every rich-text profile,
 * (3) has a registered renderer, and (4) actually renders through the real public
 * pipeline without falling back to {@link FallbackSlice} or throwing. (4) is the
 * one tsc can't give: a renderer can be wired yet reference a field that doesn't
 * exist — only executing it against real data catches that.
 *
 * Not covered here (process steps the agent runs around this): `pnpm typecheck`
 * and `convex dev --once` (schema push), which together guard the backward-compat
 * invariant — a new/extended schema must still accept existing stored slices.
 */

/** Text {@link FallbackSlice} renders; its presence in the markup means the slice
 *  had no real renderer. Kept in sync by a test that renders an unregistered type. */
export const FALLBACK_MARKER = "Unstyled slice:"

const PREVIEW_CTX: SliceRenderContext = {
  locale: "en",
  defaultLocale: "en",
  pagePaths: {},
}

export interface VerifyResult {
  type: string
  ok: boolean
  failures: string[]
  /** Non-fatal quality notes surfaced for human review. */
  warnings: string[]
}

export interface VerifySliceOptions {
  /** Source root used to inspect the registered renderer. */
  root?: string
  /** Project root holding the committed designs and the tracked contract. */
  fidelityRoot?: string
  /**
   * The directory the current aggregate run captured into. Omitted means "no
   * capture was supplied", not "look in the usual place": comparison is skipped
   * with a note rather than silently reusing an older run's output.
   */
  candidateDir?: string
  /** Generation finalization only: the candidate does not exist until the dev
   * server can render the newly created slice. All non-fidelity checks remain
   * active, and release verification never sets this option. */
  skipFidelity?: boolean
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Lint each declared renderer/presentation and its existing overlay twin
 * against the same field descriptor. An injectable root lets consumer tests
 * mutate isolated source without replacing runtime registry output. */
export function lintRendererSource(
  type: string,
  root = process.cwd(),
  declaredSources?: readonly string[]
): RendererSourceLintResult {
  const descriptor = readSliceDefinition(type as keyof typeof sliceDefs)
  const fields = descriptor as
    { primary: Primitive; items?: Primitive } | undefined
  const fieldAtAccess = (
    access: RendererHeadingFieldAccess
  ): Primitive | undefined => {
    let field: Primitive | undefined =
      access.root === "primary"
        ? fields?.primary
        : (fields?.items?.config.item as Primitive | undefined)
    const unwrapLists = (candidate: Primitive | undefined) => {
      let current = candidate
      while (current?.kind === "list") {
        current = current.config.item as Primitive
      }
      return current
    }
    for (const segment of access.path) {
      field = unwrapLists(field)
      if (field?.kind !== "group") return undefined
      field = (field.config.fields as Record<string, Primitive>)[segment]
    }
    return unwrapLists(field)
  }
  const isInlineRichTextField = fields
    ? (access: RendererHeadingFieldAccess): boolean => {
        const field = fieldAtAccess(access)
        return (
          field?.kind === "richText" &&
          resolveFieldContract(field.config).contract === "inline"
        )
      }
    : undefined

  let hasAdoptedTitle = false
  for (const definition of [fields?.primary, fields?.items]) {
    if (definition)
      walkDef(definition, ({ def }) => {
        if (
          def.kind === "richText" &&
          resolveFieldContract(def.config).contract === "title"
        ) {
          hasAdoptedTitle = true
        }
      })
  }
  const resolveContract = (
    access: RendererHeadingFieldAccess
  ): RendererFieldContractResolution => {
    const field = fieldAtAccess(access)
    if (!field) return { state: "unresolved" }
    const contract =
      field.kind === "richText"
        ? resolveFieldContract(field.config).contract
        : undefined
    const path = `${access.root === "item" ? "items" : "primary"}.${access.path.join(".")}`
    const outlineField = SLICE_OUTLINE_DESCRIPTORS[type]?.fields[path]
    // Existing outline declarations are the narrow fallback for legacy schemas
    // without richText.heading metadata. Body regions are never heading fields.
    const outlineHeading = Boolean(
      (field.kind === "richText" && field.config.heading) ||
      (outlineField && outlineField.kind !== "body")
    )
    return {
      state: "resolved",
      contract,
      outlineHeading,
      ...(type === "faq-simple" && path === "items.question"
        ? { inlineTitleHost: "accordion-row" as const }
        : {}),
      legacyHeading:
        !hasAdoptedTitle &&
        outlineHeading &&
        field.kind === "richText" &&
        contract === "inline",
    }
  }
  const defaultSource = `components/slices/${type}.tsx`
  const presentationSources: string[] = []
  // @starter-projection:hero-presentations:start
  if (type === "hero-with-image")
    presentationSources.push(
      ...HERO_PRESENTATION_DEFINITIONS.map(
        (definition) => definition.rendererSource
      )
    )
  // @starter-projection:hero-presentations:end
  const sources = new Set([
    defaultSource,
    ...(declaredSources ?? presentationSources),
  ])
  for (const source of [...sources])
    sources.add(`scripts/starter/overlay/${source}`)
  const result: RendererSourceLintResult = { failures: [], warnings: [] }
  for (const rendererSource of sources) {
    let source: string
    try {
      source = readFileSync(join(root, rendererSource), "utf8")
    } catch {
      if (declaredSources?.includes(rendererSource))
        result.failures.push(
          `${rendererSource}: field coverage missing declared presentation source`
        )
      // Preserve the optional-source behavior for injected roots and registered
      // external renderers. Present declared sources are always inspected.
      continue
    }
    const overlay = rendererSource.startsWith("scripts/starter/overlay/")
    const lint = lintRendererSourceTextWithHeadingResolver(
      source,
      isInlineRichTextField,
      !overlay
    )
    if (fields) {
      lint.failures.push(
        ...validateRendererBindings(source, type, fields, false, rendererSource)
      )
      const pending = COVERAGE_MIGRATION_PENDING.find(
        (entry) => entry.type === type && entry.sourceTarget === rendererSource
      )
      if (pending)
        lint.failures.push(
          `field coverage migration-pending ${pending.presentation}: ${pending.paths.join(", ")} — ${pending.reason}`
        )
      lint.failures.push(
        ...validateContractRendererHeadings(source, resolveContract).map(
          (failure) => `renderer content-model leak: ${failure}`
        )
      )
    }
    const label = (failure: string) =>
      rendererSource === defaultSource
        ? failure
        : `${rendererSource}: ${failure}`
    result.failures.push(...lint.failures.map(label))
    result.warnings.push(...lint.warnings.map(label))
  }
  return result
}

function validatePrimaryListRichTextFixtures(
  definition: Primitive,
  value: unknown
): string[] {
  if (primaryListFields(definition).length === 0) return []
  const failures: string[] = []
  const visit = (
    field: Primitive,
    fixture: unknown,
    path: string,
    underList: boolean
  ) => {
    if (field.kind === "list") {
      if (Array.isArray(fixture)) {
        fixture.forEach((row, index) =>
          visit(field.config.item as Primitive, row, `${path}[${index}]`, true)
        )
      }
      return
    }
    if (field.kind === "group") {
      const children = field.config.fields as Record<string, Primitive>
      for (const [name, child] of Object.entries(children)) {
        const childValue =
          fixture && typeof fixture === "object"
            ? (fixture as Record<string, unknown>)[name]
            : undefined
        visit(child, childValue, `${path}.${name}`, underList)
      }
      return
    }
    if (underList && field.kind === "richText" && typeof fixture === "string") {
      const checked = validateStrict(
        resolveFieldContract(field.config),
        fixture
      )
      if (!checked.ok) failures.push(`${path}: ${checked.error}`)
    }
  }
  visit(definition, value, "primary", false)
  return failures
}

/** Inspect the source-owned renderer root without relying on a closed slice list. */
export function inspectSliceRendererRoot(
  type: string,
  root = process.cwd()
): RendererRootInspection {
  const path = `components/slices/${type}.tsx`
  try {
    return inspectRendererRoot(
      {
        path,
        content: readFileSync(join(root, path), "utf8"),
      },
      toPascal(type)
    )
  } catch {
    return {
      rootElement: null,
      attributeInsertAt: null,
      classTokens: [],
      dataAttributes: {},
      stable: false,
      reason: "renderer-source-not-found",
    }
  }
}

function validateRelationConfigs(def: Primitive, path: string): string[] {
  const failures: string[] = []
  walkDef(
    def,
    (node) => {
      if (node.def.kind !== "relation") return
      const pageTypes = node.def.config.pageTypes
      if (
        !Array.isArray(pageTypes) ||
        pageTypes.length === 0 ||
        !pageTypes.every(
          (value) => typeof value === "string" && isPageType(value)
        )
      ) {
        failures.push(
          `${node.path}: relation pageTypes must name existing page types`
        )
      }
    },
    { path }
  )
  return failures
}

/**
 * Walk a descriptor and fail any field whose `kind` has no admin editor. Mirrors
 * the editor's own recursion: descend `group`/`list` containers, check every
 * leaf against {@link EDITABLE_FIELD_KINDS} (the editor registry's source of
 * truth). This is the systemic guard for the "uneditable slice" class — a slice
 * can pass tsc, the schema check, and even render, yet bury a field kind the
 * admin can't edit (e.g. a nested `list` before it had a recursive editor). Such
 * a slice now fails the gate instead of reaching a human as a red error in the
 * page editor.
 */
export function validateEditableKinds(def: Primitive, path: string): string[] {
  const failures: string[] = []
  walkDef(
    def,
    (node) => {
      // Containers descend; only leaf kinds are checked against the registry.
      if (node.def.kind === "group" || node.def.kind === "list") return
      if (!EDITABLE_FIELD_KINDS.has(node.def.kind)) {
        failures.push(
          `${node.path}: field kind "${node.def.kind}" has no admin editor — add a widget to EDITOR_REGISTRY and declare the kind in components/admin/fields/editable-kinds.ts`
        )
      }
    },
    { path }
  )
  return failures
}

/** Run every objective check for one slice type. Collects all failures rather
 *  than throwing on the first, so the agent sees the full picture in one pass. */
export async function verifySlice(
  type: Slice["type"],
  {
    root = process.cwd(),
    fidelityRoot = process.cwd(),
    candidateDir,
    skipFidelity = false,
  }: VerifySliceOptions = {}
): Promise<VerifyResult> {
  const failures: string[] = []
  const catalog = await readRegisteredVerificationCatalog()
  const { failures: lintFailures, warnings } = lintRendererSource(
    type,
    root,
    catalog.entries
      .filter(
        (entry) =>
          entry.type === type && entry.installed && entry.state === "active"
      )
      .map((entry) => entry.rendererSource)
  )
  failures.push(...lintFailures)

  const rendererRoot = inspectSliceRendererRoot(type, root)
  if (!rendererRoot.stable || rendererRoot.attributeInsertAt === null) {
    failures.push(
      `renderer root: ${rendererRoot.reason ?? "unstable-root"} — every registered Slice renderer must expose one stable native root`
    )
  }

  let sample: Slice
  try {
    sample = createSampleSlice(type)
  } catch (e) {
    return {
      type,
      ok: false,
      failures: [...failures, `sample synthesis threw: ${message(e)}`],
      warnings,
    }
  }

  try {
    validate(sliceValidator, sample, { throw: true })
  } catch (e) {
    failures.push(`schema: ${message(e)}`)
  }

  try {
    validateSlicesRichText([sample])
  } catch (e) {
    failures.push(`rich-text profile: ${message(e)}`)
  }

  if (!hasRenderer(type)) {
    failures.push("no renderer registered (would render FallbackSlice)")
  }

  const outlineDescriptor = SLICE_OUTLINE_DESCRIPTORS[type]
  if (outlineDescriptor)
    failures.push(...validateOutlineDescriptor(outlineDescriptor))
  const def = readSliceDefinition(type)
  failures.push(...(await verifyFieldCoverage(type, def)))
  failures.push(
    ...validatePrimaryListRichTextFixtures(
      def.primary,
      readSlice(sample).primary
    )
  )
  failures.push(...validateRelationConfigs(def.primary, "primary"))
  if (def.items !== undefined)
    failures.push(...validateRelationConfigs(def.items, "items"))

  failures.push(...validateEditableKinds(def.primary, "primary"))
  if (def.items !== undefined)
    failures.push(...validateEditableKinds(def.items, "items"))

  try {
    const html = renderToStaticMarkup(
      createElement(SliceZone, {
        slices: [sample],
        outline: resolvePageOutline({
          slices: [sample],
          locale: PREVIEW_CTX.locale,
          mode: "section",
        }),
        ctx: {
          ...PREVIEW_CTX,
          presentationCatalog: catalog,
          relationCards: createSampleRelationCards([sample]),
        },
      })
    )
    if (html.includes(FALLBACK_MARKER)) {
      failures.push("rendered as FallbackSlice (renderer missing or threw)")
    }
    if (html.trim().length === 0) {
      failures.push("rendered empty markup")
    }
  } catch (e) {
    failures.push(`render threw: ${message(e)}`)
  }

  // Reference integrity (ADR-0044 §3): a reference shared byte-for-byte with
  // another type is a page screenshot masquerading as a slice crop — hard
  // failure. A very tall reference is probably a full page — warning.
  {
    const integrity = await checkReferenceIntegrity()
    const mine = new RegExp(`^${type}(?:\\.mobile)?\\.(?:png|jpg|webp)$`)
    for (const duplicate of integrity.duplicates) {
      if (!duplicate.files.some((file) => mine.test(file))) continue
      const others = duplicate.files.filter((file) => !mine.test(file))
      failures.push(
        `reference image is byte-identical to ${others.join(", ") || "another variant of this type"} — a slice reference must be a crop of this slice's section, not a shared page screenshot (ADR-0044)`
      )
    }
    for (const tall of integrity.tall) {
      if (!mine.test(tall.file)) continue
      warnings.push(
        `reference ${tall.file} is ${tall.width}×${tall.height} (taller than ${TALL_ASPECT_LIMIT}:1) — this looks like a full-page screenshot; crop it to the slice section (ADR-0044)`
      )
    }
  }

  // Settled fixture content (slice-fidelity plan §5 B5 rule 3). The tracked
  // contract — not the presence of an image file — decides which designs are
  // compared, so it also decides which need content that stays put. This sits
  // above the comparison block on purpose: `SLICE_FIDELITY=off` and
  // `skipFidelity` turn off *comparing pictures*, and a contract entry whose
  // image is missing skips the loop below entirely. None of those are reasons
  // to accept placeholder-filled content under an accepted width.
  const contract = await loadReferenceContractFile(fidelityRoot)
  const accepted = REFERENCE_VARIANTS.some((variant) =>
    contract.entries.has(referenceContractKey(type, variant))
  )
  if (accepted && !hasCuratedPreview(type)) {
    failures.push(
      `curated preview: this design has an accepted width on record, so what it renders must be settled content that only changes on purpose — not field placeholders. Add a "preview" to its descriptor in convex/lib/slices/ that matches the accepted design, covering the repeated blocks as well as the header.`
    )
  }

  // Fidelity comparison (ADR-0044 §4; slice-fidelity plan §5 B3). The committed
  // reference is the baseline and the capture is a candidate, but neither the
  // comparison's existence nor its geometry is inferred from the files any
  // more: the tracked contract says which designs have an accepted width, and
  // `candidateDir` is the directory the current aggregate run captured into.
  // Without that directory nothing is compared — a candidate left behind by an
  // earlier run must never stand in as evidence for this one.
  if (!skipFidelity && process.env.SLICE_FIDELITY !== "off") {
    // Read once for every variant: the measurements belong to the run, not to
    // any one design.
    const measurements = candidateDir
      ? await readDomMeasurements(candidateDir)
      : null

    for (const variant of REFERENCE_VARIANTS) {
      const suffix = variant === "mobile" ? ".mobile" : ""
      try {
        const reference = await getSliceReference(type, variant)
        if (!reference) continue
        if (!reference.path.endsWith(".png")) {
          failures.push(
            `fidelity(${variant}): comparison needs a PNG reference; ${reference.path} is not PNG — re-encode it`
          )
          continue
        }

        const entry = contract.entries.get(referenceContractKey(type, variant))
        if (!entry) {
          // Still a warning, and no longer a staging window: B4's repository
          // gate (`pnpm check:slices:references`) fails any *committed* design
          // that has no accepted width, so this branch is only reachable for a
          // design an author has just dropped in and not yet accepted. Failing
          // here as well would tell that author to fix the same thing twice,
          // in the one place least able to explain what accepting a width is.
          warnings.push(
            `fidelity(${variant}): this design has no accepted width on record yet, so it was not compared. Record its accepted width in ${REFERENCE_CONTRACT_PATH}.`
          )
          continue
        }
        if (!candidateDir) {
          warnings.push(
            `fidelity(${variant}): no captured picture was supplied, so nothing was compared. Run \`pnpm check:slices:fidelity\`, which captures and compares in one step.`
          )
          continue
        }

        const candidateName = `${type}${suffix}.png`
        const candidatePath = join(candidateDir, candidateName)
        const candidateExists = await stat(candidatePath)
          .then(() => true)
          .catch(() => false)
        if (!candidateExists) {
          failures.push(
            `fidelity(${variant}): this run captured no picture for ${candidateName}, so there was nothing to compare the design against. Run \`pnpm check:slices:fidelity\`, which captures and compares in one step.`
          )
          continue
        }
        // Declared shape checks (plan §5 D2). These run before the pixel
        // comparison and never `continue` past it: they answer a different
        // question — "does this still have the shape the design was accepted
        // for" — and an author fixing a width is helped by learning in the same
        // run that the headline also collapsed onto one line.
        if (entry.dom) {
          const measured =
            measurements?.measurements[referenceContractKey(type, variant)]
          if (!measured) {
            failures.push(
              `fidelity(${variant}): this design declares checks on its shape, but this run measured nothing for it, so those checks did not run. Run \`pnpm check:slices:fidelity\`, which captures and compares in one step.`
            )
          } else {
            for (const failure of evaluateDomContract(entry.dom, measured)) {
              failures.push(`fidelity(${variant}): ${failure}`)
            }
          }
        }

        const refDims = pngDimensions(
          await readFile(join(fidelityRoot, reference.path))
        )
        const candDims = pngDimensions(await readFile(candidatePath))
        if (!refDims || !candDims) {
          failures.push(`fidelity(${variant}): could not read PNG dimensions`)
          continue
        }
        if (refDims.width !== candDims.width) {
          // The viewport came from the accepted width, not from this image, so
          // "capture it again" is no longer useful advice — say what is.
          failures.push(
            `fidelity(${variant}): the design is ${refDims.width}px wide but this run captured ${candDims.width}px. The capture already used the accepted width of ${entry.cssWidth} CSS px, so capturing again will not change this — either that accepted width is wrong, or the slice does not span the full width of the page.`
          )
          continue
        }
        if (
          Math.abs(refDims.height - candDims.height) / refDims.height >
          0.02
        ) {
          failures.push(
            `fidelity(${variant}): height differs by more than 2% — reference ${refDims.height}px vs candidate ${candDims.height}px; either the render diverges structurally from the design or the reference is not a section crop (ADR-0044 §4)`
          )
          continue
        }
        // Diagnostics belong to the run that produced them.
        const diffDir = join(candidateDir, "diffs")
        await mkdir(diffDir, { recursive: true })
        const diffOutputPath = join(diffDir, `${type}${suffix}.diff.png`)
        const diff = await computeVisualDiff(
          join(fidelityRoot, reference.path),
          candidatePath,
          diffOutputPath
        )
        warnings.push(
          `fidelity(${variant}): ${diff.diffPercent.toFixed(1)}% pixel difference — review ${diffOutputPath}`
        )
      } catch (e) {
        if (message(e).includes("pixelmatch not installed")) {
          failures.push(
            "visual comparison unavailable: pixelmatch/pngjs are not installed but this slice has a reference image — run `pnpm add -D pixelmatch pngjs`"
          )
        } else {
          failures.push(
            `fidelity(${variant}): comparison failed: ${message(e)}`
          )
        }
      }
    }
  }

  return { type, ok: failures.length === 0, failures, warnings }
}
