import {
  cloneElement,
  createElement,
  isValidElement,
  type ReactNode,
} from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  SliceZone,
  type SliceRendererRegistry,
} from "@/components/slices/slice-zone"
import { sliceDefs, type Slice } from "@/convex/lib/slices"
import { walkValue } from "@/convex/lib/slices/walk"
import { readRegisteredVerificationCatalog } from "./verification-catalog"
import { richTextToPlainText } from "@/convex/lib/richtext/pmText"
import { resolvePageOutline } from "@/lib/slices/page-outline"
import type { SliceRenderContext } from "@/lib/slices/links"
import {
  COVERAGE_MIGRATION_PENDING,
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
        sliceDefs[presentation.type as Slice["type"]],
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
          sliceDefs[pending.type]
        ).find((field) => field.path === path)!.kind,
        status: pending.status,
        reason: pending.reason,
      }))
    ),
  ]
}

/** Checks emitted native hosts as well as callback execution. A helper import,
 * callback count or equal display strings cannot establish field identity. */
export function verifyCoverageFixture(
  fixture: CoverageFixture,
  descriptor: CoverageDescriptor,
  render: (slice: Slice, ctx: SliceRenderContext) => ReactNode
): string[] {
  const failures: string[] = []
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
  inspect(descriptor.primary, fixture.slice.primary, "primary")
  if (descriptor.items) inspect(descriptor.items, fixture.slice.items, "items")
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
      failures.push(
        `${path}: wrong emitted kind ${kind} (expected ${kinds.get(path) ?? "known descriptor path"})`
      )
    if (!expected.has(path))
      failures.push(`${path}: unexpected or empty field host`)
    if (
      !isValidElement<Record<string, unknown>>(rendered) ||
      typeof rendered.type !== "string"
    ) {
      failures.push(`${path}: binding must intercept its native host`)
      return rendered
    }
    const html = renderToStaticMarkup(rendered)
    const value = coverageValueAt(fixture.slice, path)
    if (kind === "richText" && suppliedValue !== value)
      failures.push(
        `${path}: callback value disagrees with the descriptor value`
      )
    if (kind === "image") {
      const image = value as { alt?: string; url?: string }
      if (!html.includes(`alt="${escape(image.alt ?? "")}"`))
        failures.push(
          `${path}: image host/value association disagrees with descriptor alt`
        )
      const src = /<img\b[^>]*\bsrc="([^"]*)"/
        .exec(html)?.[1]
        ?.replace(/&amp;/g, "&")
      const url = src ? new URL(src, "https://formulacms.invalid") : undefined
      const original =
        url?.pathname === "/_next/image" ? url.searchParams.get("url") : src
      if (original !== image.url)
        failures.push(
          `${path}: image host/value association disagrees with descriptor source URL`
        )
    } else {
      const text =
        kind === "richText" ? richTextToPlainText(String(value)) : String(value)
      const actual = html.replace(/<[^>]*>/g, "")
      if (
        (kind === "richText" ? actual.replace(/\s+/g, " ").trim() : actual) !==
        escape(text)
      )
        failures.push(
          `${path}: host/value association disagrees with descriptor value`
        )
    }
    const marked = cloneElement(rendered, { "data-formulacms-coverage": token })
    // React hoists image preload hints outside the native host. Compare the
    // host itself, including its children/attributes, in the final SliceZone
    // output; a callback followed by replacement/transformed children refuses.
    hostMarkup.set(
      token,
      renderToStaticMarkup(marked).replace(/<link\b[^>]*\/>/g, "")
    )
    return marked
  }
  const ctx: SliceRenderContext = {
    locale: "en",
    defaultLocale: "en",
    pagePaths: {},
    previewField: stamp,
    previewRichText: (field) => stamp({ ...field, kind: "richText" }),
  }
  try {
    const html = renderToStaticMarkup(
      render(structuredClone(fixture.slice) as Slice, ctx)
    )
    for (const path of expected)
      if (!seen.has(path)) failures.push(`${path}: missing emitted kit host`)
    for (const [path, tokens] of seen) {
      if (tokens.length !== 1)
        failures.push(
          `${path}: repeated binding emitted ${tokens.length} hosts`
        )
      for (const token of tokens) {
        if (html.split(`data-formulacms-coverage="${token}"`).length !== 2)
          failures.push(
            `${path}: callback host was discarded or duplicated in emitted output`
          )
        if (!hostMarkup.get(token) || !html.includes(hostMarkup.get(token)!))
          failures.push(
            `${path}: final emitted host/value association differs from the verified native host`
          )
      }
    }
  } catch (error) {
    failures.push(
      `render threw: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  return failures.map(
    (failure) => `${fixture.slice.type}/${fixture.id}: ${failure}`
  )
}

export async function verifyFieldCoverage(
  type: Slice["type"],
  descriptor: CoverageDescriptor,
  options: {
    fixtures?: CoverageFixture[]
    registry?: SliceRendererRegistry
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
        ...fixture.slice,
        presentationIdV1: presentation.id,
      } as Slice
      const current = { ...fixture, slice: recorded }
      failures.push(
        ...verifyCoverageFixture(current, descriptor, (slice, ctx) =>
          createElement(SliceZone, {
            slices: [slice],
            ctx: { ...ctx, presentationCatalog: catalog },
            outline: resolvePageOutline({
              slices: [slice],
              locale: ctx.locale,
              mode: "section",
            }),
            ...(options.registry ? { registry: options.registry } : {}),
          })
        ).map(
          (failure) =>
            `field coverage presentation ${presentation.id}: ${failure}`
        )
      )
    }
  return failures
}
