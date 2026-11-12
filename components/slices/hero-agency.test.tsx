import { sliceProfile } from "@/test-utils/slice-profile"
import type { HeroAgencySlice } from "@/convex/lib/slices/heroAgency"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { HeroAgency } from "./hero-agency"

const title = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Bold", marks: [{ type: "bold" }] },
        { type: "text", text: " italic", marks: [{ type: "italic" }] },
        { type: "text", text: " retired", marks: [{ type: "strike" }] },
        {
          type: "text",
          text: " highlighted",
          marks: [{ type: "highlight" }],
        },
      ],
    },
  ],
})

describe("HeroAgency title", () => {
  it("renders inline rich-text emphasis inside its semantic heading", sliceProfile([]), () => {
    const slice: HeroAgencySlice = {
      id: "hero",
      type: "hero-agency",
      enabled: true,
      primary: {
        eyebrow: "Services",
        title,
        description: '{"type":"doc","content":[]}',
      },
      items: [],
    }

    const html = renderToStaticMarkup(
      <HeroAgency
        slice={slice}
        ctx={{
          locale: "en",
          defaultLocale: "en",
          pagePaths: {},
          relationCards: {},
        }}
      />
    )

    const host = document.createElement("div")
    host.innerHTML = html
    expect(host.querySelector("#hero-heading")?.tagName).toBe("H2")
    expect(html).toContain("<strong>Bold</strong>")
    expect(html).toContain("<em> italic</em>")
    expect(html).toContain("<s> retired</s>")
    expect(html).toContain("<mark> highlighted</mark>")
  })

  it("keeps legacy plain-text titles visible", sliceProfile([]), () => {
    const slice: HeroAgencySlice = {
      id: "legacy-hero",
      type: "hero-agency",
      enabled: true,
      primary: {
        eyebrow: "Services",
        title: "Existing plain title",
        description: '{"type":"doc","content":[]}',
      },
      items: [],
    }

    const html = renderToStaticMarkup(
      <HeroAgency
        slice={slice}
        ctx={{
          locale: "en",
          defaultLocale: "en",
          pagePaths: {},
          relationCards: {},
        }}
      />
    )

    expect(html).toContain("Existing plain title")
  })
})
