import { PublicSurface } from "@/components/ui/public-surface"
import { resolvePageOutline } from "@/lib/blocks/page-outline"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { notFound } from "next/navigation"
import { BlockList } from "@/components/blocks/block-list"
import {
  createSampleRelationCards,
  createSampleBlock,
} from "@/lib/blocks/sample"
import {
  INSTALLED_BLOCK_TYPES,
  blockDefs,
  type Block,
} from "@/convex/lib/blocks"
import { createCoverageFixtures } from "@/lib/blocks/authoring/coverage-fixtures"
import { readBlockPresentationCatalog } from "@/convex/lib/blocks/presentations"
import type { BlockType } from "@/lib/blocks/builder"
import { getBlockCatalogItem } from "@/lib/blocks/catalog"
import { SimSampleFrame } from "./sim-sample-frame"
import { BlockWorkbenchPanel } from "./block-workbench-panel"
import type { BlockSimPageProps } from "./page"
import { tweakTargetsForSource, type TweakTargetMetadata } from "./tweak-target"

export async function BlockSimDevPage({
  params,
  searchParams,
}: BlockSimPageProps) {
  const { type } = await params
  if (!(INSTALLED_BLOCK_TYPES as string[]).includes(type)) notFound()

  const { bare, opening, coverage } = await searchParams
  const fixture =
    coverage === undefined
      ? undefined
      : createCoverageFixtures(type, blockDefs[type as BlockType]).find(
          (entry) => entry.id === coverage
        )
  if (coverage !== undefined && !fixture) notFound()
  const block = fixture
    ? (fixture.block as Block)
    : createSampleBlock(type as BlockType)
  const ctx = {
    locale: "en",
    defaultLocale: "en",
    pagePaths: {},
    relationCards: createSampleRelationCards([block]),
  }

  const outline = resolvePageOutline({
    blocks: [block],
    locale: ctx.locale,
    mode: bare !== "thumb" && opening === "1" ? "lead-or-fallback" : "section",
  })
  if (bare === "thumb") {
    const presentationCatalog = await readBlockPresentationCatalog()
    return (
      <PublicSurface
        data-public-simulator=""
        className="flex min-h-screen flex-col items-center justify-center bg-background"
      >
        <div className="mx-auto w-full max-w-[960px]">
          {!outline.leadBlockId && <h1 className="sr-only">{type}</h1>}
          <BlockList
            blocks={[block]}
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
    // min-h-screen: the block's intrinsic height drives the parent iframe size.
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
        {/* Anchor for the target layer's whole-block (`""`) path. `BlockList`
            wraps each block in a class-less keyed <div>, so this host's first
            element child is that wrapper and *its* child is the renderer's own
            root element (hero-agency's `<section>`) — the element
            `resolveClassNameSpan(source, "")` patches. Without a marker the
            layer could only derive the root as the leaves' lowest common
            ancestor, which lands on the inner content div and leaves the
            renderer root unselectable. */}
        {!outline.leadBlockId && <h1 className="sr-only">{type}</h1>}
        <SimSampleFrame
          seed={block}
          context={ctx}
          outline={outline}
          targets={tweakTargets}
        />
      </div>
    )
  }

  const catalogItem = getBlockCatalogItem(type)
  const label = catalogItem?.label ?? type
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="min-w-0">
        <h1 className="sr-only">{label} Block Editor</h1>
        <BlockWorkbenchPanel type={type as BlockType} label={label} />
      </div>
    </main>
  )
}

async function getTweakTargets(type: string): Promise<TweakTargetMetadata[]> {
  const file = `components/blocks/${type}.tsx`
  const source = await readFile(join(process.cwd(), file), "utf8")
  return tweakTargetsForSource(source, file)
}
