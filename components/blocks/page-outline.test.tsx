import { blockProfileAny, blockProfile } from "@/test-utils/block-profile"
import { beforeAll, describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { INSTALLED_BLOCK_TYPES, type Block } from "@/convex/lib/blocks"
import {
  readBlockPresentationCatalog,
  type BlockPresentationCatalog,
} from "@/convex/lib/blocks/presentations"
import { createSampleBlock } from "@/lib/blocks/sample"
import { resolvePageOutline } from "@/lib/blocks/page-outline"
import { BlockList } from "./block-list"
import { FeaturesIconGrid } from "./features-icon-grid"
import { FaqSimple } from "./faq-simple"
import { DefaultBlockBodyRenderer } from "./_shared/default-block-body"
import { PageRenderer } from "@/components/content-types/page"
import { LandingPageRenderer } from "@/components/content-types/landing-page"
import { resolveRenderedBlockPresentation } from "./presentations/resolution"
import type { BlockBodyRendererProps } from "@/components/content-types/types"

let catalog: BlockPresentationCatalog
beforeAll(async () => {
  catalog = await readBlockPresentationCatalog()
})
const doc = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [
      { type: "paragraph", content: text ? [{ type: "text", text }] : [] },
    ],
  })
function host(html: string) {
  const container = document.createElement("div")
  container.innerHTML = html
  return container
}
function props(
  blocks: Block[],
  locale: string,
  type = "page"
): BlockBodyRendererProps {
  return {
    page: {
      pageType: type,
    } as BlockBodyRendererProps["page"],
    content: {
      title: "Page title",
      blocks,
    } as BlockBodyRendererProps["content"],
    blocks,
    ctx: {
      locale,
      defaultLocale: "en",
      pagePaths: {},
      presentationCatalog: catalog,
    },
    locale,
    renderLocale: locale,
    defaultLocale: "en",
    bylines: [],
  }
}
function ordered(container: HTMLElement) {
  const headings = [...container.querySelectorAll("h1,h2,h3,h4,h5,h6")]
  const ranks = headings.map((h) => Number(h.tagName.slice(1)))
  for (let i = 1; i < ranks.length; i++)
    expect(ranks[i]).toBeLessThanOrEqual(ranks[i - 1] + 1)
  for (const heading of headings)
    expect(heading.textContent?.trim()).not.toBe("")
  expect(
    container.querySelector(
      "button h1,button h2,button h3,a h1,a h2,a h3,h1 h2,h2 h3"
    )
  ).toBeNull()
}

describe("outlines through real consumers", () => {
  it.each(["What does <input> do?", "&ensp;"])(
    "preserves literal plain-text FAQ question %s and its trigger", blockProfile(["faq-simple"]),
    (question) => {
      const faq = createSampleBlock("faq-simple")
      faq.items = [{ ...faq.items[0], question }]
      const container = host(
        renderToStaticMarkup(
          <DefaultBlockBodyRenderer {...props([faq], "en")} />
        )
      )
      expect(container.querySelector("h3 button")?.textContent).toBe(question)
      expect(container.querySelectorAll("button[aria-controls]")).toHaveLength(
        1
      )
    }
  )

  it.each(["<p>&#32;</p>", "<p>&ensp;</p>"])(
    "keeps exactly one fallback h1 for whitespace-entity Hero title %s", blockProfile(["hero-with-image"]),
    (title) => {
      const hero = createSampleBlock("hero-with-image")
      hero.primary.title = title
      const container = host(
        renderToStaticMarkup(
          <DefaultBlockBodyRenderer {...props([hero], "en")} />
        )
      )
      expect(container.querySelectorAll("h1")).toHaveLength(1)
      expect(container.querySelector("h1")?.textContent).toBe("Page title")
    }
  )
  for (const profileRow of [
    ["features-icon-grid", FeaturesIconGrid],
    ["faq-simple", FaqSimple],
  ] as const) {
    it.each([profileRow])("preserves h2 section and h3 children without outline for %s", blockProfile([]),
      (type, Renderer) => {
        const block = createSampleBlock(type)
        const container = host(
          renderToStaticMarkup(
            // Each renderer's public context remains additive for existing callers.
            <Renderer
              block={block as never}
              ctx={{ locale: "en", defaultLocale: "en", pagePaths: {} }}
            />
          )
        )
        expect(container.querySelectorAll("h2")).toHaveLength(1)
        expect(container.querySelectorAll("h3").length).toBeGreaterThan(0)
      }
    )
  }

  it.each(["en", "fr"])(
    "keeps one h1 in the default block-body renderer in %s", blockProfile(["faq-simple","hero-with-image"]),
    (locale) => {
      const hero = createSampleBlock("hero-with-image")
      hero.primary.title = doc("Opening title")
      const later = { ...hero, id: "later", presentationIdV1: "centered" }
      const first = createSampleBlock("faq-simple")
      for (const [blocks, expectedTitle] of [
        [[], "Page title"],
        [[hero, later], "Opening title"],
        [[first, hero], "Opening title"],
        [
          [{ ...hero, primary: { ...hero.primary, title: doc("") } }, later],
          "Opening title",
        ],
        [[{ ...hero, enabled: false }, later], "Opening title"],
      ] as Array<[Block[], string]>) {
        const input = props(blocks, locale)
        const container = host(
          renderToStaticMarkup(<DefaultBlockBodyRenderer {...input} />)
        )
        expect(container.querySelectorAll("h1")).toHaveLength(1)
        expect(container.querySelector("h1")?.textContent).toBe(
          expectedTitle
        )
        ordered(container)
        expect(container.innerHTML).not.toMatch(/data-(preview|tweak)-/)
      }
    }
  )
  it.skipIf(INSTALLED_BLOCK_TYPES.length === 0).each(INSTALLED_BLOCK_TYPES)(
    "renders %s with explicit section mode and no page h1", blockProfileAny(INSTALLED_BLOCK_TYPES),
    (type) => {
      const block = createSampleBlock(type)
      const input = props([block], "en")
      const container = host(
        renderToStaticMarkup(
          <BlockList
            blocks={[block]}
            ctx={input.ctx}
            outline={resolvePageOutline({
              blocks: [block],
              locale: "en",
              mode: "section",
            })}
          />
        )
      )
      expect(container.querySelector("h1")).toBeNull()
      ordered(container)
      expect(container.innerHTML).not.toMatch(/data-(preview|tweak)-/)
    }
  )
  it("shifts a body heading under its actual rendered parent and never adopts stored levels", blockProfile(["rich-text-body"]), () => {
    const rich = createSampleBlock("rich-text-body")
    rich.primary.body = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Body first" }],
        },
        {
          type: "heading",
          attrs: { level: 4 },
          content: [{ type: "text", text: "Body nested" }],
        },
      ],
    })
    const before = JSON.stringify(rich)
    const container = host(
      renderToStaticMarkup(
        <DefaultBlockBodyRenderer {...props([rich], "fr")} />
      )
    )
    expect(
      [...container.querySelectorAll("h1,h2,h3")].map((x) => [
        x.tagName,
        x.textContent,
      ])
    ).toEqual([
      ["H1", "Page title"],
      ["H2", "Body first"],
      ["H3", "Body nested"],
    ])
    expect(JSON.stringify(rich)).toBe(before)
    ordered(container)
  })
  it("omits empty section/item heading hosts and collapses their parent depth", blockProfile(["features-icon-grid"]), () => {
    const features = createSampleBlock("features-icon-grid")
    features.primary.heading = doc("")
    features.items[0].title = doc("")
    const container = host(
      renderToStaticMarkup(
        <DefaultBlockBodyRenderer {...props([features], "en")} />
      )
    )
    ordered(container)
    expect(container.querySelector("h3")).toBeNull()
    expect(
      container.querySelector("section")?.hasAttribute("aria-labelledby")
    ).toBe(false)
  })
})

it("keeps basic body headings below a rendered FAQ question", blockProfile(["faq-simple"]), () => {
  const faq = createSampleBlock("faq-simple")
  faq.items = faq.items.slice(0, 1)
  faq.primary.heading = doc("FAQ")
  faq.items[0].question = "Question"
  faq.items[0].answer = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Answer heading" }],
      },
    ],
  })
  const container = host(
    renderToStaticMarkup(<DefaultBlockBodyRenderer {...props([faq], "en")} />)
  )
  expect(container.querySelector("h4")?.textContent).toBe("Answer heading")
  ordered(container)
})

it("closes a leading body gap and skips empty body headings", blockProfile(["rich-text-body"]), () => {
  const rich = createSampleBlock("rich-text-body")
  rich.primary.body = JSON.stringify({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 3 }, content: [] },
      {
        type: "heading",
        attrs: { level: 3 },
        content: [{ type: "text", text: "First" }],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Next" }],
      },
      {
        type: "heading",
        attrs: { level: 3 },
        content: [{ type: "text", text: "Child" }],
      },
    ],
  })
  const container = host(
    renderToStaticMarkup(<DefaultBlockBodyRenderer {...props([rich], "en")} />)
  )
  expect(
    [...container.querySelectorAll("h1,h2,h3")].map((x) => [
      x.tagName,
      x.textContent,
    ])
  ).toEqual([
    ["H1", "Page title"],
    ["H2", "First"],
    ["H2", "Next"],
    ["H3", "Child"],
  ])
  ordered(container)
})

it("does not count empty body ranks between equal sibling headings", blockProfile(["rich-text-body"]), () => {
  const rich = createSampleBlock("rich-text-body")
  rich.primary.body = JSON.stringify({
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [] },
      ...["First", "Second"].map((text) => ({
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text }],
      })),
    ],
  })
  const container = host(
    renderToStaticMarkup(<DefaultBlockBodyRenderer {...props([rich], "en")} />)
  )
  expect(
    [...container.querySelectorAll("h2")].map((x) => x.textContent)
  ).toEqual(["First", "Second"])
  ordered(container)
})

describe("RF4b public ownership", () => {
  it.each([
    ["F09", "fr", "fr", "Titre unique"],
    ["M05", "en", "en", "English opening"],
    ["M05", "fr", "en", ""],
  ])(
    "%s %s resolves the selected locale through Page and LandingPage", blockProfile(["faq-simple","hero-with-image"]),
    (_operation, locale, defaultLocale, firstTitle) => {
      for (const presentationId of ["default", "centered"]) {
        expect(
          resolveRenderedBlockPresentation(catalog, {
            type: "hero-with-image",
            presentationId,
          })
        ).toMatchObject({
          status: "resolved",
          resolvedId: presentationId,
          newAssignable: true,
        })
        expect(
          catalog.entries.find(
            (entry) =>
              entry.type === "hero-with-image" && entry.id === presentationId
          )?.state
        ).toBe("active")
        const makeHero = (id: string, title: string) => {
          const sample = createSampleBlock("hero-with-image")
          return {
            ...sample,
            id,
            presentationIdV1: presentationId,
            primary: { ...sample.primary, title: doc(title) },
          }
        }
        const section = createSampleBlock("faq-simple")
        section.primary.heading = doc("Preceding section")
        const disabled = {
          ...makeHero("disabled", "Disabled title"),
          enabled: false,
        }
        const hidden = makeHero("hidden", "")
        hidden.primary.title = "<script>Hidden title</script>"
        const first = makeHero("first", firstTitle)
        const later = makeHero("later", "Later localized title")
        for (const [type, Renderer] of [
          ["page", PageRenderer],
          ["landing-page", LandingPageRenderer],
        ] as const) {
          for (const [blocks, expectedTitle] of [
            [[], "Page title"],
            [[section], "Page title"],
            [[section, disabled, hidden, makeHero("empty", "")], "Page title"],
            [[section, first], firstTitle || "Page title"],
            [
              [section, disabled, hidden, first, later],
              firstTitle || "Later localized title",
            ],
          ] as Array<[Block[], string]>) {
            const input = props(blocks, locale, type)
            input.defaultLocale = defaultLocale
            input.ctx.defaultLocale = defaultLocale
            const container = host(
              renderToStaticMarkup(<Renderer {...input} />)
            )
            expect(container.querySelectorAll("h1")).toHaveLength(1)
            expect(container.querySelector("h1")?.textContent).toBe(
              expectedTitle
            )
            expect(
              container.querySelector("h1")?.classList.contains("sr-only")
            ).toBe(blocks.length > 0 && expectedTitle === "Page title")
            expect(
              container.querySelector(
                "#disabled-heading,#hidden-heading,#empty-heading"
              )
            ).toBeNull()
            if (expectedTitle !== "Page title") {
              const headings = [...container.querySelectorAll("h1,h2")]
              expect(headings[0].tagName).toBe("H2")
              expect(headings[0].textContent).toBe("Preceding section")
              if (firstTitle && blocks.includes(later)) {
                expect(container.querySelector("#later-heading")?.tagName).toBe(
                  "H2"
                )
                expect(
                  container.querySelector("#later-heading")?.className
                ).toBe(container.querySelector("#first-heading")?.className)
              }
            }
            ordered(container)
            expect(container.innerHTML).not.toMatch(/data-(preview|tweak)-/)
          }
        }
      }
    }
  )
})

for (const profileRow of ["hero-agency", "hero-with-image", "features-icon-grid"] as const) {
  it.each([profileRow])("resolves real %s supporting body headings relative to their visible parents", blockProfile([profileRow]),
    (type) => {
      const body = JSON.stringify({
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "Body heading" }],
          },
          {
            type: "heading",
            attrs: { level: 3 },
            content: [{ type: "text", text: "Body subheading" }],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "Body paragraph" }],
          },
        ],
      })
      const block = createSampleBlock(type)
      if (block.type === "features-icon-grid") {
        block.primary.body = body
        block.items = [{ ...block.items[0], body }]
        const container = host(
          renderToStaticMarkup(
            <DefaultBlockBodyRenderer {...props([block], "en")} />
          )
        )
        expect(
          [...container.querySelectorAll("h3")].map((node) => node.textContent)
        ).toContain("Body heading")
        expect(
          [...container.querySelectorAll("h4")].map((node) => node.textContent)
        ).toEqual(expect.arrayContaining(["Body subheading", "Body heading"]))
        expect(container.querySelector("h5")?.textContent).toBe("Body subheading")
        ordered(container)
      } else {
        block.primary.description = body
        for (const presentationIdV1 of type === "hero-with-image"
          ? [undefined, "centered"]
          : [undefined]) {
          const opening = { ...block, presentationIdV1 }
          const later = { ...block, id: "later-body", presentationIdV1 }
          const container = host(
            renderToStaticMarkup(
              <DefaultBlockBodyRenderer {...props([opening, later], "en")} />
            )
          )
          expect(
            [...container.querySelectorAll("h2")].map((node) => node.textContent)
          ).toContain("Body heading")
          expect(
            [...container.querySelectorAll("h3")].map((node) => node.textContent)
          ).toEqual(expect.arrayContaining(["Body subheading", "Body heading"]))
          expect(container.querySelector("h4")?.textContent).toBe(
            "Body subheading"
          )
          expect(container.querySelector("p div,p p,p ul,p ol")).toBeNull()
          ordered(container)
        }
      }
    }
  )
}
