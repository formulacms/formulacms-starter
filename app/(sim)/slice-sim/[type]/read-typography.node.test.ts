// @vitest-environment node
import { expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { simulatorTypographyFromSource } from "./read-typography"
import { TYPOGRAPHY_ROLES } from "@/lib/slices/visual-tweak/capabilities"
import { typographyTokenName } from "@/lib/slices/visual-tweak/typography"

test("reads current real-role declarations without exposing hash-bound identities", () => {
  const values = simulatorTypographyFromSource(
    readFileSync("app/globals.css", "utf8")
  )
  expect(Object.keys(values)).toEqual([
    "display",
    "title",
    "heading",
    "lead",
    "body",
    "caption",
  ])
  expect(values.body).toEqual({
    "font-size": "1rem",
    "line-height": "1.6",
    "letter-spacing": "inherit",
  })
  expect(values.display?.["font-size"]).toBe(
    "clamp(2.25rem, 1.7rem + 2.4vw, 3rem)"
  )
  expect(JSON.stringify(values)).not.toMatch(/declarationId|sourceHash/)
})

test.each([
  ["@theme inline { --text-body: 1rem; --text-body: 2rem; }", undefined],
  [
    "@theme inline { --text-body: 1rem; } .dark { --text-body: 2rem; }",
    undefined,
  ],
  [".custom { --text-body: 1rem; }", undefined],
  ["@theme inline { --text-body: 1rem; }", "1rem"],
])("requires one unambiguous editable declaration: %s", (source, expected) => {
  expect(simulatorTypographyFromSource(source).body?.["font-size"]).toBe(
    expected
  )
})

const tokenValues = {
  "font-size": "1rem",
  "line-height": "1.6",
  "letter-spacing": "inherit",
} as const
const allDeclarations = TYPOGRAPHY_ROLES.flatMap((role) =>
  Object.entries(tokenValues).map(
    ([property, value]) =>
      `${typographyTokenName(role, property as keyof typeof tokenValues)}: ${value};`
  )
).join("\n")

test("admits all role companions only in the existing top-level inline theme", () => {
  expect(
    simulatorTypographyFromSource(`@theme inline { ${allDeclarations} }`)
  ).toEqual(
    Object.fromEntries(TYPOGRAPHY_ROLES.map((role) => [role, tokenValues]))
  )
})

test.each([
  "@theme inline { TOKEN_DECLARATIONS TOKEN_DECLARATIONS }",
  "@theme inline { TOKEN_DECLARATIONS } .dark { TOKEN_DECLARATIONS }",
  "@theme { TOKEN_DECLARATIONS }",
  "@theme inline reference { TOKEN_DECLARATIONS }",
  "@theme inline { @theme inline { TOKEN_DECLARATIONS } }",
  "@media (min-width: 640px) { @theme inline { TOKEN_DECLARATIONS } }",
  "@theme inline { @media (min-width: 640px) { TOKEN_DECLARATIONS } }",
  "@supports (display: grid) { @theme inline { TOKEN_DECLARATIONS } }",
  "@layer tokens { @theme inline { TOKEN_DECLARATIONS } }",
  "@theme inline { @layer tokens { TOKEN_DECLARATIONS } }",
  "@theme inline { :root { TOKEN_DECLARATIONS } }",
  "@theme inline { .scope { TOKEN_DECLARATIONS } }",
  "@layer tokens { :root { TOKEN_DECLARATIONS } }",
  "@layer tokens { @media (min-width: 640px) { .scope { TOKEN_DECLARATIONS } } }",
])(
  "refuses scoped or unsupported contexts for every role companion: %s",
  (wrapper) => {
    expect(
      simulatorTypographyFromSource(
        wrapper.replaceAll("TOKEN_DECLARATIONS", allDeclarations)
      )
    ).toEqual(Object.fromEntries(TYPOGRAPHY_ROLES.map((role) => [role, {}])))
  }
)
