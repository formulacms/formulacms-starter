import { createSampleBlock } from "@/convex/lib/blocks/sample"
import { blockProfile } from "@/test-utils/block-profile"
import { expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { HeroAgency } from "@/components/blocks/hero-agency"


it("NEW renders actual unqueried public source without renderer/revision/location stamps", blockProfile([]), () => {
  const html = renderToStaticMarkup(
    <HeroAgency
      block={createSampleBlock("hero-agency")}
      ctx={{ locale: "en", defaultLocale: "en", pagePaths: {} }}
    />
  )
  expect(html).toContain("<h2")
  expect(html).not.toMatch(/data-preview-(renderer|revision)|data-tweak-loc/)
})
