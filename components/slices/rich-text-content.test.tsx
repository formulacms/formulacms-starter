import { sliceProfile } from "@/test-utils/slice-profile"
import { readFileSync } from "node:fs"
import { cloneElement, isValidElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { createSampleSlice } from "@/lib/slices/sample"
import { FeaturesIconGrid } from "./features-icon-grid"
import { FaqSimple } from "./faq-simple"
import { HeroWithImageCentered } from "./presentations/hero-with-image-centered"
import { HeroAgency } from "./hero-agency"
import { HeroWithImage } from "./hero-with-image"
import { RichTextBody } from "./rich-text-body"
import { RichTextContent } from "./rich-text-content"
import { BASIC_PARAGRAPH_GAP } from "@/lib/rich-text/basic-text-paste"
import { parseFieldPath } from "@/components/slice-kit/field-path"
import type { SliceRenderContext } from "@/lib/slices/links"

const ctx: SliceRenderContext = {
  locale: "en",
  defaultLocale: "en",
  pagePaths: {},
}

describe("rich-text optional admin interception", () => {
  it("keeps public hero/body markup free of editing scaffolding", sliceProfile([]), () => {
    const html = renderToStaticMarkup(
      <>
        <HeroAgency slice={createSampleSlice("hero-agency")} ctx={ctx} />
        <HeroWithImage slice={createSampleSlice("hero-with-image")} ctx={ctx} />
        <RichTextBody slice={createSampleSlice("rich-text-body")} ctx={ctx} />
      </>
    )
    expect(html).not.toMatch(/data-preview|contenteditable|ProseMirror/)
    expect(html).toContain("<h2")
    expect(html).toContain("font-public-heading")
  })

  it("passes explicit descriptor paths and the unchanged public node to admin interception", sliceProfile([]), () => {
    const intercept = vi.fn(
      (
        field: Parameters<NonNullable<SliceRenderContext["previewRichText"]>>[0]
      ) => field.rendered
    )
    const slice = createSampleSlice("hero-agency")
    const intercepted = renderToStaticMarkup(
      <HeroAgency slice={slice} ctx={{ ...ctx, previewRichText: intercept }} />
    )
    const normal = renderToStaticMarkup(<HeroAgency slice={slice} ctx={ctx} />)
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
  it.each([profileRow])("%s %s inherits the existing field typography at the basic prose root", sliceProfile([]),
    (type, path, overlay) => {
      const fields: Parameters<
        NonNullable<SliceRenderContext["previewRichText"]>
      >[0][] = []
      const context = {
        ...ctx,
        previewRichText: (
          field: Parameters<NonNullable<SliceRenderContext["previewRichText"]>>[0]
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
          <FeaturesIconGrid slice={createSampleSlice(type)} ctx={context} />
        ) : type === "hero-agency" ? (
          <HeroAgency slice={createSampleSlice(type)} ctx={context} />
        ) : type === "centered" ? (
          <HeroWithImageCentered
            slice={createSampleSlice("hero-with-image")}
            ctx={context}
          />
        ) : (
          <HeroWithImage slice={createSampleSlice(type)} ctx={context} />
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

it("FAQ answers carry the same gap through the real slice renderer and preview interception", sliceProfile([]), () => {
  const answers: string[] = []
  renderToStaticMarkup(<FaqSimple slice={createSampleSlice("faq-simple")} ctx={{
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
