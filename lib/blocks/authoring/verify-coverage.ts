import {
  cloneElement,
  createElement,
  isValidElement,
  type ReactNode,
} from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  BlockList,
  type BlockRendererRegistry,
} from "@/components/blocks/block-list"
import { blockDefs, type Block } from "@/convex/lib/blocks"
import { walkValue } from "@/convex/lib/blocks/walk"
import { readRegisteredVerificationCatalog } from "./verification-catalog"
import { richTextToPlainText } from "@/convex/lib/richtext/pmText"
import { resolvePageOutline } from "@/lib/blocks/page-outline"
import type { BlockRenderContext } from "@/lib/blocks/links"
import type { BlockPresentationCatalog } from "@/convex/lib/blocks/presentations"
import type { CoverageOutcome } from "./coverage-report"
import {
  COVERAGE_EXCLUSIONS,
  COVERAGE_MIGRATION_PENDING,
  LEGACY_WHOLE_BLOCK_TYPE,
  type CoverageExclusion,
  fieldCoverageInventory,
  type CoverageDescriptor,
} from "./field-coverage"
import {
  createCoverageFixtures,
  coverageValueAt,
  type CoverageFixture,
} from "./coverage-fixtures"

const escape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
const canonical = (path: string) => path.replace(/\[(\d+)\]/g, ".$1")

/** Concise machine-readable source inventory: exact catalog presentation,
 * source target, canonical path, field kind, reason and migration status. */
export async function readFieldCoverageInventory() {
  const catalog = await readRegisteredVerificationCatalog()
  return [
    ...catalog.entries.flatMap((presentation) =>
      fieldCoverageInventory(
        presentation.type,
        blockDefs[presentation.type as Block["type"]],
        {
          presentation: presentation.id,
          sourceTarget: presentation.rendererSource,
        }
      )
    ),
    ...COVERAGE_MIGRATION_PENDING.flatMap((pending) =>
      pending.paths.map((path) => ({
        type: pending.type,
        presentation: pending.presentation,
        sourceTarget: pending.sourceTarget,
        path,
        kind: fieldCoverageInventory(
          pending.type,
          blockDefs[pending.type]
        ).find((field) => field.path === path)!.kind,
        status: pending.status,
        reason: pending.reason,
      }))
    ),
  ]
}

/** One binding defect at a canonical field path (`items.0.title`). */
export type CoverageDefect = { path: string; kind?: string; problem: string }

/** Binding defects, kept apart from a render that could not complete: a
 * thrown render proves nothing about the bindings it did not reach. */
function inspectCoverageFixture(
  fixture: CoverageFixture,
  descriptor: CoverageDescriptor,
  render: (block: Block, ctx: BlockRenderContext) => ReactNode
): { defects: CoverageDefect[]; renderError?: string } {
  const defects: CoverageDefect[] = []
  const fail = (path: string, problem: string) =>
    defects.push({ path, kind: kinds.get(path), problem })
  const seen = new Map<string, string[]>()
  const hostMarkup = new Map<string, string>()
  const kinds = new Map<string, string>()
  const inspect = (
    def: CoverageDescriptor["primary"],
    value: unknown,
    path: string
  ) =>
    walkValue(
      def,
      value,
      ({ path: at, def: field }) => kinds.set(canonical(at), field.kind),
      path
    )
  inspect(descriptor.primary, fixture.block.primary, "primary")
  if (descriptor.items) inspect(descriptor.items, fixture.block.items, "items")
  const expected = new Set(fixture.expectedPaths)
  const stamp = ({
    fieldPath,
    kind,
    rendered,
    value: suppliedValue,
  }: {
    fieldPath: string
    kind: string
    rendered: ReactNode
    value?: unknown
  }): ReactNode => {
    const path = canonical(fieldPath)
    const token = `host-${seen.size}-${seen.get(path)?.length ?? 0}`
    const entries = seen.get(path) ?? []
    entries.push(token)
    seen.set(path, entries)
    if (kinds.get(path) !== kind)
      fail(
        path,
        `wrong emitted kind ${kind} (expected ${kinds.get(path) ?? "known descriptor path"})`
      )
    if (!expected.has(path)) fail(path, `unexpected or empty field host`)
    if (
      !isValidElement<Record<string, unknown>>(rendered) ||
      typeof rendered.type !== "string"
    ) {
      fail(path, `binding must intercept its native host`)
      return rendered
    }
    const html = renderToStaticMarkup(rendered)
    const value = coverageValueAt(fixture.block, path)
    if (kind === "richText" && suppliedValue !== value)
      fail(path, `callback value disagrees with the descriptor value`)
    if (kind === "image") {
      const image = value as { alt?: string; url?: string }
      if (!html.includes(`alt="${escape(image.alt ?? "")}"`))
        fail(path, `image host/value association disagrees with descriptor alt`)
      const src = /<img\b[^>]*\bsrc="([^"]*)"/
        .exec(html)?.[1]
        ?.replace(/&amp;/g, "&")
      const url = src ? new URL(src, "https://formulacms.invalid") : undefined
      const original =
        url?.pathname === "/_next/image" ? url.searchParams.get("url") : src
      if (original !== image.url)
        fail(
          path,
          `image host/value association disagrees with descriptor source URL`
        )
    } else {
      const text =
        kind === "richText" ? richTextToPlainText(String(value)) : String(value)
      const actual = html.replace(/<[^>]*>/g, "")
      if (
        (kind === "richText" ? actual.replace(/\s+/g, " ").trim() : actual) !==
        escape(text)
      )
        fail(path, `host/value association disagrees with descriptor value`)
    }
    const marked = cloneElement(rendered, { "data-formulacms-coverage": token })
    // React hoists image preload hints outside the native host. Compare the
    // host itself, including its children/attributes, in the final BlockList
    // output; a callback followed by replacement/transformed children refuses.
    hostMarkup.set(
      token,
      renderToStaticMarkup(marked).replace(/<link\b[^>]*\/>/g, "")
    )
    return marked
  }
  const ctx: BlockRenderContext = {
    locale: "en",
    defaultLocale: "en",
    pagePaths: {},
    previewField: stamp,
    previewRichText: (field) => stamp({ ...field, kind: "richText" }),
  }
  try {
    const html = renderToStaticMarkup(
      render(structuredClone(fixture.block) as Block, ctx)
    )
    for (const path of expected)
      if (!seen.has(path)) fail(path, `missing emitted kit host`)
    for (const [path, tokens] of seen) {
      if (tokens.length !== 1)
        fail(path, `repeated binding emitted ${tokens.length} hosts`)
      for (const token of tokens) {
        if (html.split(`data-formulacms-coverage="${token}"`).length !== 2)
          fail(
            path,
            `callback host was discarded or duplicated in emitted output`
          )
        if (!hostMarkup.get(token) || !html.includes(hostMarkup.get(token)!))
          fail(
            path,
            `final emitted host/value association differs from the verified native host`
          )
      }
    }
  } catch (error) {
    return {
      defects,
      renderError: error instanceof Error ? error.message : String(error),
    }
  }
  return { defects }
}

/** Checks emitted native hosts as well as callback execution. A helper import,
 * callback count or equal display strings cannot establish field identity. */
export function verifyCoverageFixture(
  fixture: CoverageFixture,
  descriptor: CoverageDescriptor,
  render: (block: Block, ctx: BlockRenderContext) => ReactNode
): string[] {
  const { defects, renderError } = inspectCoverageFixture(
    fixture,
    descriptor,
    render
  )
  return [
    ...defects.map(({ path, problem }) => `${path}: ${problem}`),
    ...(renderError === undefined ? [] : [`render threw: ${renderError}`]),
  ].map((failure) => `${fixture.block.type}/${fixture.id}: ${failure}`)
}

/** Render one block through the public BlockList, as a page renders it. */
function renderInBlockList(
  catalog: BlockPresentationCatalog,
  registry?: BlockRendererRegistry
) {
  return function renderBlock(block: Block, ctx: BlockRenderContext) {
    return createElement(BlockList, {
      blocks: [block],
      ctx: { ...ctx, presentationCatalog: catalog },
      outline: resolvePageOutline({
        blocks: [block],
        locale: ctx.locale,
        mode: "section",
      }),
      ...(registry ? { registry } : {}),
    })
  }
}

export async function verifyFieldCoverage(
  type: Block["type"],
  descriptor: CoverageDescriptor,
  options: {
    fixtures?: CoverageFixture[]
    registry?: BlockRendererRegistry
  } = {}
): Promise<string[]> {
  const catalog = await readRegisteredVerificationCatalog()
  const presentations = catalog.entries.filter(
    (entry) =>
      entry.type === type && entry.installed && entry.state === "active"
  )
  if (!presentations.length)
    return [`field coverage ${type}: missing declared presentation`]
  const fixtures = options.fixtures ?? createCoverageFixtures(type, descriptor)
  const required = createCoverageFixtures(type, descriptor)
  const failures = required
    .filter(
      (fixture) => !fixtures.some((candidate) => candidate.id === fixture.id)
    )
    .map(
      (fixture) => `field coverage ${type}: missing branch case ${fixture.id}`
    )
  for (const presentation of presentations)
    for (const fixture of fixtures) {
      const recorded = {
        ...fixture.block,
        presentationIdV1: presentation.id,
      } as Block
      const current = { ...fixture, block: recorded }
      failures.push(
        ...verifyCoverageFixture(
          current,
          descriptor,
          renderInBlockList(catalog, options.registry)
        ).map(
          (failure) =>
            `field coverage presentation ${presentation.id}: ${failure}`
        )
      )
    }
  return failures
}

/** Build mode (ADR-0059, amendment 2026-11-21 (7)): the populated fixture of
 * one presentation. The full finite branch matrix stays in source tests and
 * `blocks:author`; passing only `filled` to {@link verifyFieldCoverage} would
 * report every omitted branch as missing. */
export function checkPresentationCoverage(
  entry: { type: string; presentation: string; rendererSource: string },
  descriptor: CoverageDescriptor | undefined,
  render: (block: Block, ctx: BlockRenderContext) => ReactNode,
  exclusions: readonly CoverageExclusion[] = COVERAGE_EXCLUSIONS
): CoverageOutcome {
  const whole = exclusions.find(
    (exclusion) => exclusion.type === entry.type && exclusion.path === "*"
  )
  if (whole && entry.type !== LEGACY_WHOLE_BLOCK_TYPE)
    return {
      ...entry,
      outcome: "failed",
      defects: [
        {
          path: "*",
          problem: `only the legacy ${LEGACY_WHOLE_BLOCK_TYPE} block may skip field coverage as a whole`,
        },
      ],
    }
  if (whole) return { ...entry, outcome: "legacy", reason: whole.reason }
  let inspected: ReturnType<typeof inspectCoverageFixture>
  let fields: number
  try {
    if (!descriptor)
      throw new Error(`No block descriptor is registered for ${entry.type}.`)
    const filled = createCoverageFixtures(
      entry.type,
      descriptor,
      exclusions
    ).find((fixture) => fixture.id === "filled")
    if (!filled) return { ...entry, outcome: "passed", fields: 0 }
    fields = filled.expectedPaths.length
    inspected = inspectCoverageFixture(
      {
        ...filled,
        block: {
          ...filled.block,
          presentationIdV1: entry.presentation,
        } as CoverageFixture["block"],
      },
      descriptor,
      render
    )
  } catch (error) {
    return {
      ...entry,
      outcome: "unverified",
      error: error instanceof Error ? error.message : String(error),
    }
  }
  if (inspected.renderError !== undefined)
    return { ...entry, outcome: "unverified", error: inspected.renderError }
  return inspected.defects.length
    ? { ...entry, outcome: "failed", defects: inspected.defects }
    : { ...entry, outcome: "passed", fields }
}

/** Every installed, active presentation of the registered catalog. */
export async function checkBlockFieldCoverage(): Promise<CoverageOutcome[]> {
  const catalog = await readRegisteredVerificationCatalog()
  const render = renderInBlockList(catalog)
  return catalog.entries
    .filter((entry) => entry.installed && entry.state === "active")
    .map((entry) =>
      checkPresentationCoverage(
        {
          type: entry.type,
          presentation: entry.id,
          rendererSource: entry.rendererSource,
        },
        blockDefs[entry.type as Block["type"]],
        render
      )
    )
}
