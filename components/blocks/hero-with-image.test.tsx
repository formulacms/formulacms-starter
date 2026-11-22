import { createSampleBlock } from "@/convex/lib/blocks/sample"
import { blockProfile } from "@/test-utils/block-profile"
import type { HeroWithImageBlock } from "@/convex/lib/blocks/heroWithImage"
import { cloneElement, isValidElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { BlockRenderContext } from "@/lib/blocks/links"

import { HeroWithImage } from "./hero-with-image"

describe("HeroWithImage", () => {
  it("keeps the shipped fixed frame and opts into uniform selected-crop cover", blockProfile([]), () => {
    const block = createSampleBlock("hero-with-image") as HeroWithImageBlock
    block.primary.image = {
      url: "/coherent-crop.jpg",
      width: 1500,
      height: 1200,
      crop: { x: 25, y: 0, width: 50, height: 100 },
      cropSize: { width: 750, height: 1200 },
    }
    const doc = new DOMParser().parseFromString(
      renderToStaticMarkup(
        <HeroWithImage
          block={block}
          ctx={{ locale: "en", defaultLocale: "en", pagePaths: {} }}
        />
      ),
      "text/html"
    )
    const frame = doc.querySelector('[class*="fcm-media-v2-w-cover"]')!
    expect(frame).not.toBeNull()
    expect(frame.parentElement?.classList).toContain("h-70")
    expect(frame.parentElement?.classList).toContain("md:h-96")
    expect(frame.parentElement?.classList).toContain("lg:h-full")
    expect(frame.parentElement?.classList).toContain("lg:w-1/2")
    expect(frame.querySelector("span img")).not.toBeNull()
  })

  it("bounds long rich titles without losing emphasis or explicit line breaks", blockProfile([]), () => {
    const block = createSampleBlock("hero-with-image") as HeroWithImageBlock
    const longTitle =
      "SupercalifragilisticexpialidociousSupercalifragilisticexpialidocious"
    block.primary.title = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: longTitle, marks: [{ type: "bold" }] },
            { type: "hardBreak" },
            {
              type: "text",
              text: "A continued title",
              marks: [{ type: "italic" }],
            },
          ],
        },
      ],
    })
    const container = document.createElement("div")
    container.innerHTML = renderToStaticMarkup(
      <HeroWithImage
        block={block}
        ctx={{
          locale: "en",
          defaultLocale: "en",
          pagePaths: {},
          relationCards: {},
        }}
      />
    )

    const heading = container.querySelector("h2")!
    // jsdom does not lay out CSS; viewport containment needs browser verification.
    expect(heading.classList).toContain("w-full")
    expect(heading.classList).toContain("min-w-0")
    expect(heading.classList).toContain("max-w-sm")
    expect(heading.classList).toContain("[overflow-wrap:anywhere]")
    // A stored break reads as one space (ADR-0055 amendment).
    expect(heading.textContent).toBe(`${longTitle} A continued title`)
    expect(heading.querySelector("strong")?.textContent).toBe(longTitle)
    expect(heading.querySelector("em")?.textContent).toBe("A continued title")
    expect(heading.querySelectorAll("br")).toHaveLength(0)
    expect(heading.id).toBe(`${block.id}-heading`)
    expect(container.querySelector("section")).toHaveAttribute(
      "aria-labelledby",
      heading.id
    )
  })

  it("renders the reference-backed announcement, portrait, and actions", blockProfile([]), () => {
    const block = createSampleBlock("hero-with-image") as HeroWithImageBlock
    const html = renderToStaticMarkup(
      <HeroWithImage
        block={block}
        ctx={{
          locale: "en",
          defaultLocale: "en",
          pagePaths: {},
          relationCards: {},
        }}
      />
    )

    const careersLink = html.match(
      /<a [^>]*href="https:\/\/example\.com\/careers"[^>]*>.*?<\/a>/
    )?.[0]
    expect(careersLink).toContain("We&#x27;re hiring!")
    expect(careersLink).toContain("Join our remote team")
    expect(html).toContain('alt="Person standing in a creative studio"')
    expect(html).toContain("url=%2Fblock-samples%2Fhero-with-image.webp")
    expect(html.indexOf("Demo")).toBeLessThan(html.indexOf("Sign up"))
  })
})
describe("Hero kit preview identity", () => {
  it("stamps each migrated field on its semantic DOM host once and keeps public markup clear", blockProfile([]), () => {
    const block = createSampleBlock("hero-with-image") as HeroWithImageBlock
    const previewField = vi.fn<NonNullable<BlockRenderContext["previewField"]>>(
      ({ fieldPath, rendered }) =>
        isValidElement<Record<string, unknown>>(rendered)
          ? cloneElement(rendered, { "data-preview-field": fieldPath })
          : rendered
    )
    const previewRichText = vi.fn<
      NonNullable<BlockRenderContext["previewRichText"]>
    >(({ fieldPath, profile, rendered }) =>
      isValidElement<Record<string, unknown>>(rendered)
        ? cloneElement(rendered, {
            "data-preview-field": fieldPath,
            "data-preview-inline-contract": profile,
          })
        : rendered
    )
    const previewKitBlock = vi.fn<
      NonNullable<BlockRenderContext["previewKitBlock"]>
    >((rendered) =>
      isValidElement<Record<string, unknown>>(rendered)
        ? cloneElement(rendered, { "data-preview-field-kit": "true" })
        : rendered
    )
    const ctx: BlockRenderContext = {
      locale: "en",
      defaultLocale: "en",
      pagePaths: {},
      relationCards: {},
      previewField,
      previewRichText,
      previewKitBlock,
    }
    const preview = document.createElement("div")
    preview.innerHTML = renderToStaticMarkup(
      <HeroWithImage block={block} ctx={ctx} />
    )

    expect(
      preview.querySelector("section[data-preview-field-kit='true']")
    ).not.toBeNull()
    for (const path of [
      "primary.eyebrow",
      "primary.eyebrowLinkLabel",
      "primary.title",
      "primary.description",
      "primary.image",
      "items.0.label",
      "items.1.label",
    ]) {
      expect(
        preview.querySelectorAll(`[data-preview-field='${path}']`)
      ).toHaveLength(1)
    }
    expect(
      preview.querySelector("h2[data-preview-field='primary.title']")
    ).toHaveAttribute("id", `${block.id}-heading`)
    expect(
      preview.querySelector("img[data-preview-field='primary.image']")
    ).not.toBeNull()
    const image = preview.querySelector(
      "img[data-preview-field='primary.image']"
    )!
    expect(image.getAttribute("sizes")).toBe("(min-width: 1024px) 50vw, 100vw")
    expect(image.getAttribute("loading")).toBe("eager")
    expect(image.getAttribute("fetchpriority")).toBe("high")
    expect(preview.querySelector("a[data-preview-field]")).toBeNull()

    const publicMarkup = renderToStaticMarkup(
      <HeroWithImage
        block={block}
        ctx={{
          locale: "en",
          defaultLocale: "en",
          pagePaths: {},
          relationCards: {},
        }}
      />
    )
    expect(publicMarkup).not.toMatch(
      /data-preview-(?:field|field-kit|inline-profile)/
    )
  })

  it("omits empty description and eyebrow wrappers without changing the default image column", blockProfile([]), () => {
    const block = createSampleBlock("hero-with-image") as HeroWithImageBlock
    block.primary.description = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph" }],
    })
    block.primary.eyebrow = "   "
    const container = document.createElement("div")
    container.innerHTML = renderToStaticMarkup(
      <HeroWithImage
        block={block}
        ctx={{
          locale: "en",
          defaultLocale: "en",
          pagePaths: {},
          relationCards: {},
        }}
      />
    )
    expect(container.querySelector(".text-lead")).toBeNull()
    expect(
      container.querySelector("section")?.getAttribute("aria-labelledby")
    ).toBe(`${block.id}-heading`)
    expect(container.querySelector("h2")?.id).toBe(`${block.id}-heading`)
    expect(container.querySelector("h2")?.textContent).toContain(
      "People who care"
    )
    expect(
      container.querySelector("[data-preview-field='primary.description']")
    ).toBeNull()
    expect(
      container.querySelector("section > div > div > div > div")
    ).not.toBeNull()
    expect(container.querySelector("img")).not.toBeNull()
  })
})


it.each(["", "An authored scene"])("ED3 hero keeps authored alt or empty alt (%s) and uses logical positioning", blockProfile([]), (alt) => {
  const block = createSampleBlock("hero-with-image") as HeroWithImageBlock
  block.primary.image = { url: "https://example.com/hero.png", alt }
  const container = document.createElement("div")
  container.innerHTML = renderToStaticMarkup(<HeroWithImage block={block} ctx={{ locale: "en", defaultLocale: "en", pagePaths: {} }} />)
  expect(container.querySelector("img")).toHaveAttribute("alt", alt)
  expect(container.querySelector('[class*="lg:end-0"]')).not.toBeNull()
  expect(container.querySelector('[class*="lg:right-0"]')).toBeNull()
})
