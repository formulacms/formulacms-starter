import { describe, expect, test } from "vitest"
import { validateContractRendererHeadings } from "./renderer-heading-rule"
import type { RendererFieldContractResolution } from "./renderer-heading-rule"

function contractAt(
  access: { root: string; path: string[] }
): RendererFieldContractResolution {
  const path = access.path.join(".")
  if (path === "title" || path === "cards.title") {
    return { state: "resolved", contract: "title" }
  }
  if (path === "body") return { state: "resolved", contract: "basic" }
  if (path === "summary") return { state: "resolved", contract: "inline" }
  return { state: "unresolved" }
}

describe("new factory renderer heading contract", () => {
  test("strict mode rejects literal and expression heading tags", () => {
    expect(
      validateContractRendererHeadings(
        '<section><RichText fieldPath="primary.title" as="h2" /></section>',
        contractAt,
        true
      ).join(" ")
    ).toMatch(/must not set as="h2"/)

    expect(
      validateContractRendererHeadings(
        '<section><RichText fieldPath="primary.title" as={"h3"} /></section>',
        contractAt,
        true
      ).join(" ")
    ).toMatch(/must not set as="h3"/)

    expect(
      validateContractRendererHeadings(
        '<section><Text fieldPath="primary.body" as="p" /><h2><RichText fieldPath="primary.summary" /></h2></section>',
        contractAt,
        true
      ).join(" ")
    ).toMatch(/literal heading element/)
  })

  test("strict mode rejects nested title hosts and accepts role-only titles", () => {
    const violations = validateContractRendererHeadings(
      '<section><button><RichText fieldPath="primary.title" /></button><a><RichText fieldPath={`primary.cards[${index0}].title`} /></a></section>',
      contractAt,
      true
    )
    expect(violations.join(" ")).toMatch(/button or link elements/)
    expect(violations.join(" ")).toMatch(/primary.cards.title/)

    expect(
      validateContractRendererHeadings(
        '<section><RichText fieldPath="primary.title" /><RichText fieldPath="primary.summary" as="span" /><RichText fieldPath="primary.body" as="div" /></section>',
        contractAt,
        true
      )
    ).toEqual([])
  })

  test("RF4d compatibility refuses undeclared double legacy hosts and protects title fields", () => {
    expect(
      validateContractRendererHeadings(
        '<section><h2><RichText fieldPath="primary.summary" as="h2" /></h2></section>',
        contractAt
      ).join(" ")
    ).toMatch(/renderer heading policy/)

    const violations = validateContractRendererHeadings(
      '<section><h2><RichText fieldPath="primary.title" /></h2><Button><RichText fieldPath="primary.cards[0].title" /></Button></section>',
      contractAt
    )
    expect(violations.join(" ")).toMatch(/literal heading element/)
    expect(violations.join(" ")).toMatch(/button or link elements/)
  })
})
