import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const testDirectory = dirname(fileURLToPath(import.meta.url))
const localHeaderSource = resolve(testDirectory, "site-header.tsx")
const overlayHeaderSource = resolve(
  testDirectory,
  "../../scripts/starter/overlay/components/public/site-header.tsx"
)
const headerSources = [
  localHeaderSource,
  ...(existsSync(overlayHeaderSource) ? [overlayHeaderSource] : []),
]

describe("public site header", () => {
  test.each(headerSources)(
    "%s forwards the complete resolved tree without a component-local type mirror",
    (sourcePath) => {
      const source = readFileSync(sourcePath, "utf8")

      expect(source).toMatch(
        /<MainNav\s+items=\{mainMenuItems\}\s+cardsBySource=\{cardsBySource\}\s*\/>/
      )
      expect(source).toMatch(
        /<MobileNav\s+items=\{mainMenuItems\}\s+logoSlot=\{logoSlot\}\s+cardsBySource=\{cardsBySource\}\s*\/>/
      )
      expect(source).not.toContain("const navLinks")
      expect(source).not.toContain("as Parameters<typeof MainNav>")
    }
  )

  test.each(headerSources)(
    "%s reserves the configured logo dimensions before the image loads",
    (sourcePath) => {
      const source = readFileSync(sourcePath, "utf8")
      const imageClasses = source.match(
        /<Image[\s\S]*?className="([^"]+)"[\s\S]*?(?:priority|preload)/
      )?.[1]

      expect(imageClasses).toBeDefined()
      expect(imageClasses?.split(/\s+/)).toEqual(
        expect.arrayContaining([
          "h-8",
          "w-[120px]",
          "object-contain",
          "object-left",
        ])
      )
      expect(imageClasses?.split(/\s+/)).not.toContain("w-auto")
    }
  )
})


test("ED3 logo preserves preloading through the documented preload prop", () => {
  const source = readFileSync(localHeaderSource, "utf8")
  const image = source.match(/<Image[\s\S]*?\/>/)?.[0]
  expect(image).toMatch(/\s+preload(?:\s|\/>)/)
  expect(image).not.toMatch(/\s+priority(?:\s|\/>)/)
})
