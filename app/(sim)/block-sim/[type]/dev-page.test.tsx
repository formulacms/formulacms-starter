import { blockProfile } from "@/test-utils/block-profile"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import type { HeroWithImageBlock } from "@/convex/lib/blocks"
import {
  readBlockPresentationCatalog,
  type BlockPresentationCatalog,
} from "@/convex/lib/blocks/presentations"
import {
  createSampleRelationCards,
  createSampleBlock,
} from "@/lib/blocks/sample"
import { HeroWithImage } from "@/components/blocks/hero-with-image"
import { HeroWithImageCentered } from "@/components/blocks/presentations/hero-with-image-centered"
import { BlockSimDevPage } from "./dev-page"

const site = vi.hoisted(() => ({ defaults: {} }))
vi.mock("@/components/blocks/presentations/site-defaults", () => ({
  SITE_PRESENTATION_DEFAULTS: site.defaults,
}))
vi.mock("@/lib/blocks/sample", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/blocks/sample")>()
  return {
    ...actual,
    createSampleBlock: (
      type: Parameters<typeof actual.createSampleBlock>[0]
    ) => ({
      ...actual.createSampleBlock(type),
      id: "thumbnail-test-block",
    }),
  }
})
vi.mock("@/convex/lib/blocks/presentations", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/convex/lib/blocks/presentations")>()
  return {
    ...actual,
    readBlockPresentationCatalog: vi.fn(actual.readBlockPresentationCatalog),
  }
})
// The workbench owns a separate caller registry. Keep that dispatch observable
// without importing its build-time tweak-loc instrumentation into this test.
vi.mock("@/components/blocks/block-sim-registry", () => ({
  BLOCK_SIM_COMPONENTS: {
    "hero-with-image": () => <section data-workbench-legacy="" />,
  },
}))
vi.mock("./sim-size-reporter", () => ({ SimSizeReporter: () => null }))
vi.mock("./block-target-layer", () => ({ BlockTargetLayer: () => null }))
vi.mock("./block-workbench-panel", () => ({ BlockWorkbenchPanel: () => null }))

let catalog: BlockPresentationCatalog
beforeAll(async () => {
  catalog = await readBlockPresentationCatalog()
})
beforeEach(() => {
  vi.mocked(readBlockPresentationCatalog).mockClear()
  for (const key of Object.keys(site.defaults))
    Reflect.deleteProperty(site.defaults, key)
})

function configure(id = "centered", stale = false) {
  Object.assign(site.defaults, {
    "hero-with-image": {
      id,
      typeContractSha256: stale
        ? "sha256:stale-contract"
        : catalog.contractDigests["hero-with-image"],
      presentationContractSha256: catalog.entries.find(
        (entry) => entry.type === "hero-with-image" && entry.id === "centered"
      )!.contractSha256,
    },
  })
}

async function renderRoute(bare: string) {
  return renderToStaticMarkup(
    await BlockSimDevPage({
      params: Promise.resolve({ type: "hero-with-image" }),
      searchParams: Promise.resolve({ bare }),
    })
  )
}

function renderedSection(markup: string) {
  return new DOMParser()
    .parseFromString(markup, "text/html")
    .querySelector("section")?.outerHTML
}

function expectedSection(centered = false) {
  const block = createSampleBlock("hero-with-image") as HeroWithImageBlock
  const ctx = {
    locale: "en",
    defaultLocale: "en",
    pagePaths: {},
    relationCards: createSampleRelationCards([block]),
    presentationCatalog: catalog,
  }
  return renderedSection(
    renderToStaticMarkup(
      centered ? (
        <HeroWithImageCentered block={block} ctx={ctx} />
      ) : (
        <HeroWithImage block={block} ctx={ctx} />
      )
    )
  )
}

describe("new: simulator thumbnail presentation resolution", () => {
  test("configured default renders the owned centered presentation", blockProfile(["hero-with-image"]), async () => {
    configure()
    const section = renderedSection(await renderRoute("thumb"))
    expect(section).toBe(expectedSection(true))
    expect(section).not.toBe(expectedSection())
    expect(readBlockPresentationCatalog).toHaveBeenCalledOnce()
  })

  test("empty configuration preserves the exact legacy sample render", blockProfile(["hero-with-image"]), async () => {
    expect(renderedSection(await renderRoute("thumb"))).toBe(expectedSection())
  })

  test("unavailable configured presentation falls back to legacy", blockProfile(["hero-with-image"]), async () => {
    configure("missing-design")
    expect(renderedSection(await renderRoute("thumb"))).toBe(expectedSection())
  })

  test("stale configured contract falls back to legacy", blockProfile(["hero-with-image"]), async () => {
    configure("centered", true)
    expect(renderedSection(await renderRoute("thumb"))).toBe(expectedSection())
  })

  test("qualified catalog cannot hide an absent Type", blockProfile(["hero-with-image"]), async () => {
    configure()
    vi.mocked(readBlockPresentationCatalog).mockResolvedValueOnce({
      ...catalog,
      installedTypes: catalog.installedTypes.filter(
        (type) => type !== "hero-with-image"
      ),
    })
    await expect(renderRoute("thumb")).rejects.toThrow("type-unavailable")
  })

  test("ordinary bare workbench keeps its own legacy dispatch", blockProfile(["hero-with-image"]), async () => {
    configure()
    const section = renderedSection(await renderRoute("1"))
    expect(section).toBe('<section data-workbench-legacy=""></section>')
    expect(readBlockPresentationCatalog).not.toHaveBeenCalled()
  })
})
