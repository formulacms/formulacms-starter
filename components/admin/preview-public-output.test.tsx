import { createSampleSlice } from "@/convex/lib/slices/sample"
import { sliceProfile } from "@/test-utils/slice-profile"
import { expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { HeroAgency } from "@/components/slices/hero-agency"


it("NEW renders actual unqueried public source without renderer/revision/location stamps", sliceProfile([]), () => {
  const html = renderToStaticMarkup(
    <HeroAgency
      slice={createSampleSlice("hero-agency")}
      ctx={{ locale: "en", defaultLocale: "en", pagePaths: {} }}
    />
  )
  expect(html).toContain("<h2")
  expect(html).not.toMatch(/data-preview-(renderer|revision)|data-tweak-loc/)
})
