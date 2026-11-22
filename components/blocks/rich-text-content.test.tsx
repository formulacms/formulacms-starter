import { blockProfile } from "@/test-utils/block-profile"
import { readFileSync } from "node:fs"
import { cloneElement, isValidElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { createSampleBlock } from "@/lib/blocks/sample"
import { FeaturesIconGrid } from "./features-icon-grid"
import { FaqSimple } from "./faq-simple"
import { HeroWithImageCentered } from "./presentations/hero-with-image-centered"
import { HeroAgency } from "./hero-agency"
import { HeroWithImage } from "./hero-with-image"
import { RichTextBody } from "./rich-text-body"
import { RichTextContent } from "./rich-text-content"
import { BASIC_PARAGRAPH_GAP } from "@/lib/rich-text/basic-text-paste"
import { parseFieldPath } from "@/components/block-kit/field-path"
import type { BlockRenderContext } from "@/lib/blocks/links"

const ctx: BlockRenderContext = {
  locale: "en",
  defaultLocale: "en",
  pagePaths: {},
}

describe("rich-text optional admin interception", () => {
  it("keeps public hero/body markup free of editing scaffolding", blockProfile([]), () => {
    const html = renderToStaticMarkup(
      <>
        <HeroAgency block={createSampleBlock("hero-agency")} ctx={ctx} />
        <HeroWithImage block={createSampleBlock("hero-with-image")} ctx={ctx} />
        <RichTextBody block={createSampleBlock("rich-text-body")} ctx={ctx} />
      </>
    )
    expect(html).not.toMatch(/data-preview|contenteditable|ProseMirror/)
    expect(html).toContain("<h2")
    expect(html).toContain("font-public-heading")
  })

  it("passes explicit descriptor paths and the unchanged public node to admin interception", blockProfile([]), () => {
    const intercept = vi.fn(
      (
        field: Parameters<NonNullable<BlockRenderContext["previewRichText"]>>[0]
      ) => field.rendered
    )
    const block = createSampleBlock("hero-agency")
    const intercepted = renderToStaticMarkup(
      <HeroAgency block={block} ctx={{ ...ctx, previewRichText: intercept }} />
    )
    const normal = renderToStaticMarkup(<HeroAgency block={block} ctx={ctx} />)
    expect(intercepted).toBe(normal)
    expect(intercept.mock.calls.map(([field]) => field.fieldPath)).toEqual([
      "primary.title",
      "primary.description",
    ])
    expect(
      intercept.mock.calls.map(([field]) => [
        field.fieldPath,
        field.contract,
        field.profile,
      ])
    ).toEqual([
      ["primary.title", "title", "inline"],
      ["primary.description", "basic", "basic"],
    ])
  })

  it("never intercepts an uninstrumented rich-text renderer", () => {
    const intercept = vi.fn()
    renderToStaticMarkup(
      <RichTextContent
        value="Text"
        profile="inline"
        ctx={{ ...ctx, previewRichText: intercept }}
      />
    )
    expect(intercept).not.toHaveBeenCalled()
  })
})

for (const profileRow of [
  ["features-icon-grid", "primary.body", "features-icon-grid"],
  ["features-icon-grid", "items[0].body", "features-icon-grid"],
  ["hero-agency", "primary.description", "hero-agency"],
  ["hero-with-image", "primary.description", "hero-with-image"],
  ["centered", "primary.description", undefined],
] as const) {
  it.each([profileRow])("%s %s inherits the existing field typography at the basic prose root", blockProfile([]),
    (type, path, overlay) => {
      const fields: Parameters<
        NonNullable<BlockRenderContext["previewRichText"]>
      >[0][] = []
      const context = {
        ...ctx,
        previewRichText: (
          field: Parameters<NonNullable<BlockRenderContext["previewRichText"]>>[0]
        ) => {
          fields.push(field)
          return isValidElement<Record<string, unknown>>(field.rendered)
            ? cloneElement(field.rendered, {
                "data-body-typography-proof": field.fieldPath,
              })
            : field.rendered
        },
      }
      const html = renderToStaticMarkup(
        type === "features-icon-grid" ? (
          <FeaturesIconGrid block={createSampleBlock(type)} ctx={context} />
        ) : type === "hero-agency" ? (
          <HeroAgency block={createSampleBlock(type)} ctx={context} />
        ) : type === "centered" ? (
          <HeroWithImageCentered
            block={createSampleBlock("hero-with-image")}
            ctx={context}
          />
        ) : (
          <HeroWithImage block={createSampleBlock(type)} ctx={context} />
        )
      )
      const field = fields.find(
        (field) => field.fieldPath === parseFieldPath(path).join(".")
      )
      expect(field).toBeDefined()
      expect(field!.contract).toBe("basic")
      const container = document.createElement("div")
      container.innerHTML = html
      const bodyHost = container.querySelector<HTMLElement>(
        `[data-body-typography-proof="${parseFieldPath(path).join(".")}"]`
      )!
      expect(bodyHost).not.toBeNull()
      const isFeatures = type === "features-icon-grid"
      const typographyOwner = isFeatures ? bodyHost.parentElement! : bodyHost
      const prose = bodyHost.querySelector(":scope > .prose")
      expect(prose).not.toBeNull()
      for (const utility of BASIC_PARAGRAPH_GAP.split(" "))
        expect(prose!.classList).toContain(utility)
      for (const property of ["font-size", "line-height", "color"]) {
        const utility = `${isFeatures ? "[&>div>.prose]" : "[&>.prose]"}:[${property}:inherit]`
        expect(typographyOwner.className.split(" ")).toContain(utility)

      }
    }
  )
}

it.each(["basic", "inline", "full"] as const)("%s display applies the shared gap only to basic and retains stored paragraphs", (profile) => {
  const value = JSON.stringify({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "One" }] },
    { type: "paragraph" },
    { type: "paragraph", content: [{ type: "text", text: "Two" }] },
  ] })
  const container = document.createElement("div")
  container.innerHTML = renderToStaticMarkup(<RichTextContent value={value} profile={profile} />)
  const host = container.firstElementChild!
  for (const utility of BASIC_PARAGRAPH_GAP.split(" "))
    expect(host.classList.contains(utility)).toBe(profile === "basic")
  if (profile !== "inline") expect(host.querySelectorAll(":scope > p")).toHaveLength(3)
})

it("FAQ answers carry the same gap through the real block renderer and preview interception", blockProfile([]), () => {
  const answers: string[] = []
  renderToStaticMarkup(<FaqSimple block={createSampleBlock("faq-simple")} ctx={{
    ...ctx,
    previewRichText: (field) => {
      if (field.fieldPath === "items.0.answer") {
        expect(field.profile).toBe("basic")
        answers.push(renderToStaticMarkup(<>{field.rendered}</>))
      }
      return field.rendered
    },
  }} />)
  expect(answers).toHaveLength(1)
  const container = document.createElement("div")
  container.innerHTML = answers[0]
  for (const utility of BASIC_PARAGRAPH_GAP.split(" "))
    expect(container.querySelector(".prose")!.classList).toContain(utility)
})
