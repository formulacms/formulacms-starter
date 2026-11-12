import { PublicSurface } from "@/components/ui/public-surface"
import { resolvePageOutline } from "@/lib/slices/page-outline"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { notFound } from "next/navigation"
import { SliceZone } from "@/components/slices/slice-zone"
import {
  createSampleRelationCards,
  createSampleSlice,
} from "@/lib/slices/sample"
import {
  INSTALLED_SLICE_TYPES,
  sliceDefs,
  type Slice,
} from "@/convex/lib/slices"
import { createCoverageFixtures } from "@/lib/slices/authoring/coverage-fixtures"
import { readSlicePresentationCatalog } from "@/convex/lib/slices/presentations"
import type { SliceType } from "@/lib/slices/builder"
import { getSliceCatalogItem } from "@/lib/slices/catalog"
import { SimSampleFrame } from "./sim-sample-frame"
import { SliceWorkbenchPanel } from "./slice-workbench-panel"
import type { SliceSimPageProps } from "./page"
import { tweakTargetsForSource, type TweakTargetMetadata } from "./tweak-target"

export async function SliceSimDevPage({
  params,
  searchParams,
}: SliceSimPageProps) {
  const { type } = await params
  if (!(INSTALLED_SLICE_TYPES as string[]).includes(type)) notFound()

  const { bare, opening, coverage } = await searchParams
  const fixture =
    coverage === undefined
      ? undefined
      : createCoverageFixtures(type, sliceDefs[type as SliceType]).find(
          (entry) => entry.id === coverage
        )
  if (coverage !== undefined && !fixture) notFound()
  const slice = fixture
    ? (fixture.slice as Slice)
    : createSampleSlice(type as SliceType)
  const ctx = {
    locale: "en",
    defaultLocale: "en",
    pagePaths: {},
    relationCards: createSampleRelationCards([slice]),
  }

  const outline = resolvePageOutline({
    slices: [slice],
    locale: ctx.locale,
    mode: bare !== "thumb" && opening === "1" ? "lead-or-fallback" : "section",
  })
  if (bare === "thumb") {
    const presentationCatalog = await readSlicePresentationCatalog()
    return (
      <PublicSurface
        data-public-simulator=""
        className="flex min-h-screen flex-col items-center justify-center bg-background"
      >
        <div className="mx-auto w-full max-w-[960px]">
          {!outline.leadSliceId && <h1 className="sr-only">{type}</h1>}
          <SliceZone
            slices={[slice]}
            ctx={{ ...ctx, presentationCatalog }}
            outline={outline}
          />
        </div>
      </PublicSurface>
    )
  }
  if (bare) {
    const tweakTargets = await getTweakTargets(type)
    // Live preview target for the responsive iframe (?bare=1). Wrapper is not
    // min-h-screen: the slice's intrinsic height drives the parent iframe size.
    return (
      <div className="bg-background">
        {/* Belt to the target layer's suspenders: block link/button navigation
            at capture phase from the moment the document parses — BEFORE React
            hydrates and attaches the picker's own click handler. Without this,
            a click landing in the post-reload/pre-hydration window would follow
            an href and navigate the preview away (P0 click-through). Only
            `preventDefault` (never `stopPropagation`), so the target layer's own
            capture listener still runs to drive selection. Dev-only route. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "document.addEventListener('click',function(e){var t=e.target;" +
              "if(document.documentElement.dataset.simMode!=='preview'&&t&&t.closest&&t.closest('a,button'))e.preventDefault()},true)",
          }}
        />
        {/* Anchor for the target layer's whole-slice (`""`) path. `SliceZone`
            wraps each slice in a class-less keyed <div>, so this host's first
            element child is that wrapper and *its* child is the renderer's own
            root element (hero-agency's `<section>`) — the element
            `resolveClassNameSpan(source, "")` patches. Without a marker the
            layer could only derive the root as the leaves' lowest common
            ancestor, which lands on the inner content div and leaves the
            renderer root unselectable. */}
        {!outline.leadSliceId && <h1 className="sr-only">{type}</h1>}
        <SimSampleFrame
          seed={slice}
          context={ctx}
          outline={outline}
          targets={tweakTargets}
        />
      </div>
    )
  }

  const catalogItem = getSliceCatalogItem(type)
  const label = catalogItem?.label ?? type
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="min-w-0">
        <h1 className="sr-only">{label} Block Editor</h1>
        <SliceWorkbenchPanel type={type as SliceType} label={label} />
      </div>
    </main>
  )
}

async function getTweakTargets(type: string): Promise<TweakTargetMetadata[]> {
  const file = `components/slices/${type}.tsx`
  const source = await readFile(join(process.cwd(), file), "utf8")
  return tweakTargetsForSource(source, file)
}
