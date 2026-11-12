import { Children, isValidElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { ButtonField } from "@/convex/lib/slices"
import {
  RichTextContent,
  SliceButtons,
  SliceImage,
  sliceLinkAttrs,
} from "./render-helpers"

function containsRawHtmlSink(node: ReactNode): boolean {
  if (!isValidElement(node)) return false
  const props = node.props as Record<string, unknown>
  if (Object.hasOwn(props, "dangerouslySetInnerHTML")) return true
  return Children.toArray(props.children as ReactNode).some(containsRawHtmlSink)
}

describe("sliceLinkAttrs URL boundary", () => {
  const ctx = { locale: "en", defaultLocale: "en", pagePaths: {} }

  it("keeps target and rel flags on an allowed external URL", () => {
    expect(
      sliceLinkAttrs(
        {
          type: "external",
          url: "https://example.com",
          openInNewTab: true,
          noFollow: true,
        },
        ctx
      )
    ).toEqual({
      href: "https://example.com",
      target: "_blank",
      rel: "noopener noreferrer nofollow",
    })
  })

  it("omits unsafe links and retains media download behavior", () => {
    expect(
      sliceLinkAttrs(
        { type: "external", url: "javascript:alert(1)", openInNewTab: true },
        ctx
      )
    ).toBeNull()
    expect(
      sliceLinkAttrs({ type: "media", url: "/files/guide.pdf" }, ctx)
    ).toEqual({ href: "/files/guide.pdf", download: true })
  })
})

describe("RichTextContent XSS boundary", () => {
  it("renders stored rich text without a raw HTML sink", () => {
    const tree = RichTextContent({
      value:
        '<p>Hello<img src="x" onerror="alert(1)"><script>alert(2)</script></p>',
      profile: "full",
    })

    expect(containsRawHtmlSink(tree)).toBe(false)
    const html = renderToStaticMarkup(tree)
    expect(html).toContain("Hello")
    expect(html).not.toContain("onerror")
    expect(html).not.toContain("<script")
  })

  it("escapes attacker text and drops executable structured URLs", () => {
    const value = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: '<img src=x onerror="alert(1)">' },
            {
              type: "text",
              text: "bad link",
              marks: [{ type: "link", attrs: { href: "javascript:alert(2)" } }],
            },
          ],
        },
      ],
    })

    const html = renderToStaticMarkup(
      <RichTextContent value={value} profile="basic" />
    )

    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;")
    expect(html).not.toContain("javascript:")
    expect(html).not.toContain("<script")
  })

  it("preserves safe legacy formatting and link attributes", () => {
    const html = renderToStaticMarkup(
      <RichTextContent
        value={
          '<p><strong>Bold</strong> <a href="/about" title="About" target="_blank">link</a></p>'
        }
        profile="basic"
      />
    )

    expect(html).toContain("<p><strong>Bold</strong> ")
    expect(html).toContain(
      '<a href="/about" target="_blank" rel="noopener noreferrer" title="About">link</a>'
    )
  })

  it("keeps inline profile paragraphs in inline flow", () => {
    const value = JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "one" }] },
        { type: "paragraph", content: [{ type: "text", text: "two" }] },
      ],
    })

    const html = renderToStaticMarkup(
      <RichTextContent value={value} profile="inline" />
    )

    expect(html).toContain("one<br/><br/>two")
    expect(html).not.toContain("<p")
  })

  it("resolves stored page links through the current render context", () => {
    const value = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "About",
              marks: [
                {
                  type: "link",
                  attrs: { href: "/old", pageId: "page-1" },
                },
              ],
            },
          ],
        },
      ],
    })

    const html = renderToStaticMarkup(
      <RichTextContent
        value={value}
        profile="basic"
        ctx={{
          locale: "fr",
          defaultLocale: "en",
          pagePaths: { "page-1": "/fr/a-propos" },
        }}
      />
    )

    expect(html).toContain('href="/fr/a-propos"')
    expect(html).toContain('data-page-id="page-1"')
    expect(html).not.toContain('href="/old"')
  })

  it("preserves full-profile table structure", () => {
    const value = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  attrs: { colspan: 2 },
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Heading" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })

    const html = renderToStaticMarkup(
      <RichTextContent value={value} profile="full" />
    )

    expect(html).toContain('<table><tbody><tr><th colSpan="2">')
    expect(html).toContain("<p>Heading</p>")
  })

  it("fails closed on malformed structured content", () => {
    const malformed = JSON.stringify({
      type: "doc",
      content: [null, { content: "not-an-array" }],
    })

    expect(() =>
      renderToStaticMarkup(
        <RichTextContent value={malformed} profile="basic" />
      )
    ).not.toThrow()
  })
})

// The slice-authoring canonicalizer rewrites `aspect-[4/5]` → `aspect-4/5` and
// lets the result through the style gate. That is only correct if the class
// actually renders. SliceImage applies renderer classes and crop CSS to the
// SAME element; crop CSS must win only for a real crop — so if the crop-derived
// `aspectRatio` were always emitted, every generated ratio would be dead CSS
// that passes every gate and silently ignores the design. These tests pin the
// behaviour the canonicalizer depends on.
describe("SliceImage aspect-ratio ownership", () => {
  const uncropped = { url: "/x.jpg", alt: "x", width: 1600, height: 900 }

  it("lets a renderer's aspect class control an uncropped image", () => {
    const html = renderToStaticMarkup(
      <SliceImage image={uncropped} fill className="aspect-4/5 w-full" />
    )

    expect(html).toContain("aspect-4/5")
    // No derived aspect-ratio to override it: the design's ratio is what renders.
    expect(html).not.toContain("aspect-ratio")
  })

  it("lets an editor's crop win over the renderer's aspect class", () => {
    const html = renderToStaticMarkup(
      <SliceImage
        image={{ ...uncropped, crop: { x: 0, y: 0, width: 50, height: 100 } }}
        fill
        className="aspect-4/5"
      />
    )

    // The crop is content the editor chose deliberately, so it outranks the
    // renderer's design default — the derived ratio is emitted and wins.
    expect(html).toContain("aspect-ratio")
  })
})

describe("SliceImage legacy dimensionless layout", () => {
  it("renders an uncropped image at its natural size without a 1×1 fallback", () => {
    const html = renderToStaticMarkup(
      <SliceImage
        image={{ url: "/legacy.jpg", alt: "Legacy image" }}
        className="rounded-md"
      />
    )

    expect(html).toContain("<img")
    expect(html).toContain("max-w-full")
    expect(html).not.toContain('width="1"')
    expect(html).not.toContain('height="1"')
  })

  it("uses an audited non-zero containing block for an explicit fill image", () => {
    const html = renderToStaticMarkup(
      <div
        className="relative overflow-hidden"
        style={{ width: 320, height: 180 }}
      >
        <SliceImage
          image={{ url: "/legacy.jpg", alt: "Legacy image" }}
          fill
          className="object-cover"
        />
      </div>
    )

    expect(html).toContain("width:320px")
    expect(html).toContain("height:180px")
    expect(html).toContain("overflow-hidden")
    expect(html).toContain("absolute inset-0 size-full")
    expect(html).not.toContain("data-nimg")
    expect(html).not.toContain('width="1"')
    expect(html).not.toContain('height="1"')
  })

  it("uses crop output geometry for a dimensionless cropped image", () => {
    const html = renderToStaticMarkup(
      <SliceImage
        image={{
          url: "/legacy.jpg",
          alt: "Legacy image",
          crop: { x: 0, y: 0, width: 50, height: 100 },
          cropSize: { width: 320, height: 180 },
        }}
      />
    )

    expect(html).toContain("width:320px")
    expect(html).toContain("max-width:100%")
    expect(html).toContain("aspect-ratio:320 / 180")
    expect(html).toContain("overflow-hidden")
    expect(html).not.toContain('width="1"')
    expect(html).not.toContain('height="1"')
  })
})

describe("SliceButtons identity", () => {
  const ctx = { locale: "en", defaultLocale: "en", pagePaths: {} }

  function button(id: string | undefined, anchor?: string): ButtonField {
    return {
      id,
      label: "Learn more",
      link: anchor ? { type: "anchor", anchor } : { type: "none" },
      variant: "primary",
      withIcon: false,
      enabled: true,
    }
  }

  it("marks every rendered CTA variant for the public focus outline", () => {
    const variants = ["primary", "secondary", "outline", "ghost", "link"] as const
    for (const onBrand of [false, true]) {
      const html = renderToStaticMarkup(
        <SliceButtons
          items={variants.map((variant) => ({
            ...button(variant, variant),
            variant,
          }))}
          ctx={ctx}
          onBrand={onBrand}
        />
      )
      const container = document.createElement("div")
      container.innerHTML = html
      const links = container.querySelectorAll("a")
      expect(links).toHaveLength(variants.length)
      for (const link of links) {
        expect(link).toHaveClass("public-cta-focus")
      }
      expect(container.firstElementChild).not.toHaveClass("public-cta-focus")
    }
  })

  it("keeps a linked button's DOM identity through reorder", () => {
    const first = button("button-a", "a")
    const second = button("button-b", "b")
    const { container, rerender } = render(
      <SliceButtons items={[first, second]} ctx={ctx} />
    )
    const original = container.querySelector<HTMLAnchorElement>('a[href="#a"]')

    expect(original).not.toBeNull()
    original?.focus()
    rerender(<SliceButtons items={[second, first]} ctx={ctx} />)

    const moved = container.querySelector<HTMLAnchorElement>('a[href="#a"]')
    expect(moved).toBe(original)
    expect(document.activeElement).toBe(original)
  })

  it("renders linked and unlinked duplicate IDs without a key collision", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

    try {
      render(
        <SliceButtons
          items={[button("duplicate", "linked"), button("duplicate")]}
          ctx={ctx}
        />
      )

      expect(
        consoleError.mock.calls.some((args) =>
          args.join(" ").includes("same key")
        )
      ).toBe(false)
    } finally {
      consoleError.mockRestore()
    }
  })

  it("omits an enabled button without a resolved link", () => {
    const { container } = render(
      <SliceButtons items={[button("button-a")]} ctx={ctx} />
    )

    expect(container.querySelector("a")).toBeNull()
    expect(container.textContent).toBe("")
  })

  it("keeps a visible duplicate's DOM identity when its sibling is enabled", () => {
    const visible = button("duplicate", "visible")
    const hidden = { ...button("duplicate", "hidden"), enabled: false }
    const { container, rerender } = render(
      <SliceButtons items={[visible, hidden]} ctx={ctx} />
    )
    const original =
      container.querySelector<HTMLAnchorElement>('a[href="#visible"]')

    expect(original).not.toBeNull()
    rerender(
      <SliceButtons items={[visible, { ...hidden, enabled: true }]} ctx={ctx} />
    )

    expect(
      container.querySelector<HTMLAnchorElement>('a[href="#visible"]')
    ).toBe(original)
  })

  it("renders missing and empty IDs in collision-proof namespaces", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

    try {
      render(
        <SliceButtons
          items={[
            button(undefined, "missing"),
            button("", "empty-a"),
            button("", "empty-b"),
            button("Learn more0", "stored-id"),
          ]}
          ctx={ctx}
        />
      )

      expect(
        consoleError.mock.calls.some((args) =>
          args.join(" ").includes("same key")
        )
      ).toBe(false)
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe("SliceImage clean same-document CSS", () => {
  const image = {
    url: "/optimized.jpg",
    width: 1600,
    height: 900,
    alt: "Stored alt",
  }

  function documentFor(element: ReactNode) {
    return new DOMParser().parseFromString(
      renderToStaticMarkup(element),
      "text/html"
    )
  }

  it("keeps a dimensionless cover fallback visible without inventing metadata", () => {
    const doc = documentFor(
      <SliceImage
        image={{
          url: "/dimensionless.jpg",
          alt: "Retained asset",
          crop: { x: 25, y: 0, width: 50, height: 100 },
          cropSize: { width: 320, height: 180 },
        }}
        frame="cover"
      />
    )
    const image = doc.querySelector("img")!
    expect(image.getAttribute("src")).toBe("/dimensionless.jpg")
    expect(image.getAttribute("alt")).toBe("Retained asset")
    expect(image.classList).toContain("size-full")
    expect(image.classList).toContain("object-cover")
    expect(image.hasAttribute("width")).toBe(false)
    expect(image.hasAttribute("height")).toBe(false)
    expect(doc.querySelector("span, style, [style]")).toBeNull()
  })

  it("delivers a separate crop window in an explicitly covered frame without caller sizing classes", () => {
    const doc = documentFor(
      <SliceImage
        image={{
          url: "/coherent-crop.jpg",
          width: 1500,
          height: 1200,
          crop: { x: 25, y: 0, width: 50, height: 100 },
          cropSize: { width: 750, height: 1200 },
        }}
        frame="cover"
        className="object-cover"
      />
    )
    const frame = doc.querySelector("span")!
    const window = frame.querySelector("span")
    expect(window).not.toBeNull()
    expect(window?.querySelector("img")).not.toBeNull()
    expect(doc.querySelector("style")?.textContent).toContain(
      "width:100%;height:100%;container-type:size;"
    )
    expect(doc.querySelector("style")?.textContent).toContain(
      "width:max(100cqw,calc(100cqh * 750 / 1200));height:auto;aspect-ratio:750 / 1200;"
    )
    expect(frame.classList.contains("size-full")).toBe(false)
    expect(doc.querySelector("img")?.classList.contains("object-cover")).toBe(false)
    expect(doc.querySelector("[style]")).toBeNull()
  })

  it("delivers coherent crop aspect ownership despite renderer height utilities", () => {
    const doc = documentFor(
      <SliceImage
        image={{
          url: "/coherent-crop.jpg",
          width: 1500,
          height: 1200,
          crop: { x: 25, y: 0, width: 50, height: 100 },
          cropSize: { width: 750, height: 1200 },
        }}
        className="size-full object-cover"
      />
    )
    const wrapper = doc.querySelector("span")!
    const generated = [...wrapper.classList].find((name) =>
      name.includes("-w-sized-")
    )!
    const css = doc.querySelector("style")!.textContent!

    expect(wrapper.classList.contains("size-full")).toBe(true)
    expect(css).toContain(
      `.${generated}.${generated}{width:750px;max-width:100%;height:auto;aspect-ratio:750 / 1200;}`
    )
    expect(css).toContain("left:-50%;top:0%;width:200%;height:100%;")
    expect(doc.querySelector("img")?.getAttribute("width")).toBe("1500")
    expect(doc.querySelector("img")?.getAttribute("height")).toBe("1200")
    expect(doc.querySelector("[style]")).toBeNull()
  })

  it("retains optimizer, sizes and priority attributes without Next inline styles", () => {
    const doc = documentFor(
      <SliceImage
        image={{ ...image, focal: { x: 25.125, y: 80 } }}
        priority
        sizes="50vw"
      />
    )
    const img = doc.querySelector("img")!
    expect(img.getAttribute("src")).toContain("/_next/image?")
    expect(img.getAttribute("srcset")).toContain("640w")
    expect(img.getAttribute("sizes")).toBe("50vw")
    expect(img.getAttribute("loading")).toBe("eager")
    expect(img.getAttribute("fetchpriority")).toBe("high")
    expect(img.getAttribute("alt")).toBe("Stored alt")
    expect(doc.querySelector("style")?.textContent).toContain(
      "object-position:25.125% 80%;"
    )
    expect(
      doc.querySelectorAll(
        "[style], [data-nimg], [contenteditable], [data-source-target]"
      )
    ).toHaveLength(0)
    expect(doc.querySelector("script")).toBeNull()
  })

  it("delivers the crop stylesheet with fractional geometry and precedence selectors", () => {
    const doc = documentFor(
      <SliceImage
        image={{ ...image, crop: { x: 12.5, y: 0, width: 37.25, height: 100 } }}
        className="aspect-4/5"
      />
    )
    const wrapper = doc.querySelector("span")!
    const generated = [...wrapper.classList].find((name) =>
      name.startsWith("fcm-media-v2-w")
    )!
    const css = doc.querySelector("style")!.textContent!
    expect(css).toContain(
      `.${generated}.${generated}{width:596px;max-width:100%;height:auto;aspect-ratio:596 / 900;}`
    )
    expect(css).toContain(`left:${-(12.5 / 37.25) * 100}%;`)
    expect(wrapper.classList.contains("aspect-4/5")).toBe(true)
    expect(doc.querySelectorAll("[style]")).toHaveLength(0)
  })

  it("keeps native alt fallbacks and natural unknown dimensions style-free", () => {
    const doc = documentFor(
      <SliceImage
        image={{ url: "/legacy.jpg", alt: " " }}
        altFallback="Useful fallback"
      />
    )
    const img = doc.querySelector("img")!
    expect(img.getAttribute("src")).toBe("/legacy.jpg")
    expect(img.getAttribute("alt")).toBe("Useful fallback")
    expect(img.hasAttribute("width")).toBe(false)
    expect(img.hasAttribute("height")).toBe(false)
    expect(doc.querySelector("[style]")).toBeNull()
    expect(
      documentFor(<SliceImage image={image} decorative />)
        .querySelector("img")
        ?.getAttribute("alt")
    ).toBe("")
  })

  it("supplies dimensionless fill classes and optimized attributes without inline geometry", () => {
    const doc = documentFor(
      <SliceImage
        image={{ url: "/legacy.jpg" }}
        fill
        className="object-cover"
      />
    )
    expect([...doc.querySelector("img")!.classList]).toEqual([
      "absolute",
      "inset-0",
      "size-full",
      "object-cover",
    ])
    expect(doc.querySelector("img")?.getAttribute("sizes")).toBe("100vw")
    expect(doc.querySelector("img")?.hasAttribute("srcset")).toBe(true)
    expect(doc.querySelector("[style]")).toBeNull()
  })

  it("delivers cropSize and fill wrapper aspect CSS for a legacy source", () => {
    const doc = documentFor(
      <SliceImage
        image={{
          url: "/legacy.jpg",
          cropSize: { width: 320, height: 180 },
          focal: { x: 20, y: 70 },
        }}
        fill
      />
    )
    expect(doc.querySelector("style")?.textContent).toContain(
      "aspect-ratio:320 / 180;"
    )
    expect(doc.querySelector("style")?.textContent).toContain(
      "object-fit:cover;"
    )
    expect(doc.querySelector("style")?.textContent).toContain(
      "object-position:20% 70%;"
    )
    expect(doc.querySelector("img")?.getAttribute("src")).toBe("/legacy.jpg")
    expect(doc.querySelector("[style]")).toBeNull()
  })

  it("falls back cleanly when a crop divisor or metadata is malformed", () => {
    for (const invalid of [
      { crop: { x: 0, y: 0, width: 0, height: 100 } },
      { crop: { x: Number.NaN, y: 0, width: 50, height: 100 } },
      { cropSize: { width: Number.POSITIVE_INFINITY, height: 100 } },
      { width: Number.POSITIVE_INFINITY },
    ]) {
      const doc = documentFor(<SliceImage image={{ ...image, ...invalid }} />)
      expect(doc.querySelector("img")?.getAttribute("alt")).toBe("Stored alt")
      expect(doc.querySelector("[style], span")).toBeNull()
      expect(doc.documentElement.innerHTML).not.toMatch(/NaN|Infinity/)
    }
  })

  it("gives duplicate recipes identical lossless class/CSS output", () => {
    const framed = { ...image, crop: { x: 25, y: 0, width: 50, height: 100 } }
    const doc = documentFor(
      <>
        <SliceImage image={framed} />
        <SliceImage image={framed} />
      </>
    )
    const styles = [...doc.querySelectorAll("style")]
    expect(styles).toHaveLength(2)
    expect(styles[0].textContent).toBe(styles[1].textContent)
    const images = [...doc.querySelectorAll("img")]
    expect(images[0].className).toBe(images[1].className)
    expect(doc.querySelectorAll("[style]")).toHaveLength(0)
  })

  it("replaces mounted preview CSS instead of accumulating hoisted resources", () => {
    const { container, rerender, unmount } = render(
      <SliceImage image={{ ...image, focal: { x: 23.125, y: 70 } }} />
    )
    expect(container.querySelectorAll("style")).toHaveLength(1)
    expect(container.querySelector("style")?.textContent).toContain("23.125%")
    expect(
      window.getComputedStyle(container.querySelector("img")!).objectPosition
    ).toBe("23.125% 70%")
    rerender(<SliceImage image={{ ...image, focal: { x: 23.126, y: 70 } }} />)
    expect(container.querySelectorAll("style")).toHaveLength(1)
    expect(container.querySelector("style")?.textContent).toContain("23.126%")
    expect(
      window.getComputedStyle(container.querySelector("img")!).objectPosition
    ).toBe("23.126% 70%")
    expect(container.innerHTML).not.toContain("23.125%")
    expect(container.querySelector("img")?.hasAttribute("style")).toBe(false)
    unmount()
    expect(container.querySelector("style")).toBeNull()
  })
})
