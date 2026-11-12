import { sliceProfile } from "@/test-utils/slice-profile"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import type { HeroWithImageSlice } from "@/convex/lib/slices"
import {
  readSlicePresentationCatalog,
  type SlicePresentationCatalog,
} from "@/convex/lib/slices/presentations"
import {
  createSampleRelationCards,
  createSampleSlice,
} from "@/lib/slices/sample"
import { HeroWithImage } from "@/components/slices/hero-with-image"
import { HeroWithImageCentered } from "@/components/slices/presentations/hero-with-image-centered"
import { SliceSimDevPage } from "./dev-page"

const site = vi.hoisted(() => ({ defaults: {} }))
vi.mock("@/components/slices/presentations/site-defaults", () => ({
  SITE_PRESENTATION_DEFAULTS: site.defaults,
}))
vi.mock("@/lib/slices/sample", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/slices/sample")>()
  return {
    ...actual,
    createSampleSlice: (
      type: Parameters<typeof actual.createSampleSlice>[0]
    ) => ({
      ...actual.createSampleSlice(type),
      id: "thumbnail-test-slice",
    }),
  }
})
vi.mock("@/convex/lib/slices/presentations", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/convex/lib/slices/presentations")>()
  return {
    ...actual,
    readSlicePresentationCatalog: vi.fn(actual.readSlicePresentationCatalog),
  }
})
// The workbench owns a separate caller registry. Keep that dispatch observable
// without importing its build-time tweak-loc instrumentation into this test.
vi.mock("@/components/slices/slice-sim-registry", () => ({
  SLICE_SIM_COMPONENTS: {
    "hero-with-image": () => <section data-workbench-legacy="" />,
  },
}))
vi.mock("./sim-size-reporter", () => ({ SimSizeReporter: () => null }))
vi.mock("./slice-target-layer", () => ({ SliceTargetLayer: () => null }))
vi.mock("./slice-workbench-panel", () => ({ SliceWorkbenchPanel: () => null }))

let catalog: SlicePresentationCatalog
beforeAll(async () => {
  catalog = await readSlicePresentationCatalog()
})
beforeEach(() => {
  vi.mocked(readSlicePresentationCatalog).mockClear()
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
    await SliceSimDevPage({
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
  const slice = createSampleSlice("hero-with-image") as HeroWithImageSlice
  const ctx = {
    locale: "en",
    defaultLocale: "en",
    pagePaths: {},
    relationCards: createSampleRelationCards([slice]),
    presentationCatalog: catalog,
  }
  return renderedSection(
    renderToStaticMarkup(
      centered ? (
        <HeroWithImageCentered slice={slice} ctx={ctx} />
      ) : (
        <HeroWithImage slice={slice} ctx={ctx} />
      )
    )
  )
}

describe("new: simulator thumbnail presentation resolution", () => {
  test("configured default renders the owned centered presentation", sliceProfile(["hero-with-image"]), async () => {
    configure()
    const section = renderedSection(await renderRoute("thumb"))
    expect(section).toBe(expectedSection(true))
    expect(section).not.toBe(expectedSection())
    expect(readSlicePresentationCatalog).toHaveBeenCalledOnce()
  })

  test("empty configuration preserves the exact legacy sample render", sliceProfile(["hero-with-image"]), async () => {
    expect(renderedSection(await renderRoute("thumb"))).toBe(expectedSection())
  })

  test("unavailable configured presentation falls back to legacy", sliceProfile(["hero-with-image"]), async () => {
    configure("missing-design")
    expect(renderedSection(await renderRoute("thumb"))).toBe(expectedSection())
  })

  test("stale configured contract falls back to legacy", sliceProfile(["hero-with-image"]), async () => {
    configure("centered", true)
    expect(renderedSection(await renderRoute("thumb"))).toBe(expectedSection())
  })

  test("qualified catalog cannot hide an absent Type", sliceProfile(["hero-with-image"]), async () => {
    configure()
    vi.mocked(readSlicePresentationCatalog).mockResolvedValueOnce({
      ...catalog,
      installedTypes: catalog.installedTypes.filter(
        (type) => type !== "hero-with-image"
      ),
    })
    await expect(renderRoute("thumb")).rejects.toThrow("type-unavailable")
  })

  test("ordinary bare workbench keeps its own legacy dispatch", sliceProfile(["hero-with-image"]), async () => {
    configure()
    const section = renderedSection(await renderRoute("1"))
    expect(section).toBe('<section data-workbench-legacy=""></section>')
    expect(readSlicePresentationCatalog).not.toHaveBeenCalled()
  })
})
