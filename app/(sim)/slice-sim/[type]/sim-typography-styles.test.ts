import { expect, test } from "vitest"
import { simulatorTypographyStyles } from "./sim-typography-styles"

test("generates shared utility previews with Tailwind override fallbacks", () => {
  const sheet = simulatorTypographyStyles({
    body: {
      "font-size": { before: "1rem", after: "1.0625rem" },
      "line-height": { before: "1.6", after: "1.65" },
      "letter-spacing": { before: "inherit", after: "0.045em" },
    },
  })
  expect(sheet).toContain("@layer utilities{:root{--text-body:1.0625rem;")
  expect(sheet).toContain(
    ".text-body{font-size:var(--text-body);line-height:var(--tw-leading,var(--text-body--line-height));letter-spacing:var(--tw-tracking,var(--text-body--letter-spacing));}"
  )
  expect(sheet).not.toMatch(/style=|class=|!important/)
})

test("emits no stylesheet for discarded or unsupported values", () => {
  expect(simulatorTypographyStyles({})).toBe("")
  expect(
    simulatorTypographyStyles({
      body: { "font-size": { before: "1rem", after: "1rem;}body{color:red" } },
    })
  ).toBe("")
})
