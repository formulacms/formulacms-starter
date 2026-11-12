import type { ImageField } from "@/convex/lib/slices"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { SliceImage } from "./render-helpers"

describe("public Published Snapshot media rendering seam", () => {
  test.each([
    {
      name: "stored crop with intrinsic dimensions",
      image: {
        url: "/delivery-v1.jpg",
        alt: "Façade <courtyard>",
        width: 1600,
        height: 900,
        crop: { x: 25, y: 0, width: 50, height: 100 },
        cropSize: { width: 800, height: 900 },
        focal: { x: 40, y: 60 },
      } satisfies ImageField,
      optimized: true,
      fill: true,
      geometry: "left:-50%;top:0%;width:200%;height:100%;",
    },
    {
      name: "legacy dimensionless focal metadata",
      image: {
        url: "/legacy.jpg",
        alt: "Legacy & literal",
        focal: { x: 30, y: 70 },
      } satisfies ImageField,
      optimized: false,
      fill: false,
      geometry: "object-position:30% 70%;",
    },
  ])(
    "delivers $name without editor metadata or inline image styles",
    ({ image, optimized, fill, geometry }) => {
      const before = structuredClone(image)
      const html = renderToStaticMarkup(
        <SliceImage
          image={image}
          fill={fill}
          frame="cover"
          priority
          sizes="100vw"
          fieldPath="primary.image"
        />
      )
      const doc = new DOMParser().parseFromString(html, "text/html")
      const img = doc.querySelector("img")!
      expect(img).not.toBeNull()
      expect(img.alt).toBe(image.alt)
      expect(img.getAttribute("loading")).toBe("eager")
      expect(img.getAttribute("fetchpriority")).toBe("high")
      expect(
        doc.querySelectorAll(
          "[style], [contenteditable], [data-preview-field], [data-source-target], script"
        )
      ).toHaveLength(0)
      // Current renderer emits recipe CSS in a sibling style element. This is
      // static current-code output, not fetched optimizer/CSS or native pixels.
      const css = doc.querySelector("style")!.textContent!
      expect(css).toContain(geometry)
      for (const token of img.classList) {
        if (token.startsWith("fcm-media-"))
          expect(css).toContain(`.${token}.${token}{`)
      }
      expect(img.className).toContain("fcm-media-v2-")
      if (optimized) {
        expect(img.getAttribute("src")).toContain("/_next/image?")
        expect(img.getAttribute("srcset")).toContain("%2Fdelivery-v1.jpg")
        expect(img.getAttribute("sizes")).toBe("100vw")
        expect(img.getAttribute("width")).toBe("1600")
        expect(img.getAttribute("height")).toBe("900")
        expect(css).toContain("container-type:size;")
        expect(css).toContain("aspect-ratio:800 / 900;")
      } else {
        expect(img.getAttribute("src")).toBe(image.url)
        expect(img.hasAttribute("srcset")).toBe(false)
        expect(img.hasAttribute("width")).toBe(false)
        expect(img.hasAttribute("height")).toBe(false)
      }
      expect(image).toEqual(before)
    }
  )
})
