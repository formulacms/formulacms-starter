import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("media source projection", () => {
  it("keeps source and shipped overlay image adapters identical", () => {
    const source = readFileSync("components/slices/render-helpers.tsx", "utf8")
    function imageHelper(content: string) {
      return content.slice(
        content.indexOf("export function SliceImage"),
        content.indexOf("const ON_BRAND_VARIANT")
      )
    }
    for (const content of [
      source,
    ]) {
      expect(content).toContain(
        'import { imagePresentation, type ImageFrame } from "@/lib/media/image-presentation"'
      )
      expect(content).toContain('import { getImageProps } from "next/image"')
      expect(imageHelper(content)).not.toContain("style={")
    }
  })

  it("places the browser-compatible adapter inside the selected runtime source paths", () => {
    const target = "lib/media/image-presentation.ts"
    const source = readFileSync(target, "utf8")
    expect(source).not.toMatch(
      /node:|createHash|fetch\(|useEffect|localStorage/
    )
  })
})
