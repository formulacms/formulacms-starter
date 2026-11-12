import { createRequire } from "node:module"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import axe from "axe-core"
import { DefaultSliceBodyContent } from "@/components/slices/_shared/default-slice-body"
import {
  createSampleRelationCards,
  createSampleSlice,
} from "@/lib/slices/sample"
import type { Slice } from "@/convex/lib/slices"

// Keep this dependency in developer scripts: public rendering must never load
// axe or JSDOM. Use the installed JSDOM without adding a second type package.
const require = createRequire(import.meta.url)
const { JSDOM } = require("jsdom") as {
  JSDOM: new (
    html: string,
    options: { runScripts: "outside-only" }
  ) => {
    window: {
      document: Document
      eval(source: string): void
      axe: typeof axe
      close(): void
    }
  }
}

export type SliceAccessibilityResult = {
  failures: string[]
  warnings: string[]
  checkedLocales: string[]
}

function headingFailures(document: Document): string[] {
  const failures: string[] = []
  const headings = Array.from(
    document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']")
  )
  const levelOf = (heading: Element): number =>
    /^H[1-6]$/.test(heading.tagName)
      ? Number(heading.tagName.slice(1))
      : Number(heading.getAttribute("aria-level"))
  const firstLevelCount = headings.filter(
    (heading) => levelOf(heading) === 1
  ).length
  if (document.querySelectorAll("h1").length !== 1 || firstLevelCount !== 1) {
    failures.push(
      `expected exactly one h1; found ${firstLevelCount} level-one headings`
    )
  }
  let previousLevel = 0
  for (const heading of headings) {
    const level = levelOf(heading)
    if (level > previousLevel + 1) {
      failures.push(
        `heading order skips from level ${previousLevel} to ${level}`
      )
    }
    if (Number.isInteger(level) && level >= 1 && level <= 6)
      previousLevel = level
    if (heading.closest("button,a,[role='button'],[role='link']")) {
      failures.push("heading inside button or link")
    }
  }
  return failures
}

/** Offline semantic check of the registered fixture in both public languages.
 * This is a simulated page, not a styled browser or an application-shell audit.
 */
export async function verifySliceAccessibility(
  type: Slice["type"]
): Promise<SliceAccessibilityResult> {
  const failures: string[] = []
  const warnings = [
    "accessibility: semantic checks only (JSDOM); contrast, layout and interactive browser states require a visual/browser check.",
  ]
  const checkedLocales: string[] = []
  for (const locale of ["en", "fr"]) {
    let dom: InstanceType<typeof JSDOM> | undefined
    const prefix = `accessibility(${locale})`
    const before = failures.length
    try {
      const sample = createSampleSlice(type)
      const slices = [sample]
      const title =
        locale === "fr" ? "Page de vérification" : "Verification page"
      const html = renderToStaticMarkup(
        createElement(
          "html",
          { lang: locale },
          createElement("head", null, createElement("title", null, title)),
          createElement(
            "body",
            null,
            createElement(
              "main",
              null,
              createElement(DefaultSliceBodyContent, {
                content: { title, slices },
                slices,
                ctx: {
                  locale,
                  defaultLocale: "en",
                  pagePaths: {},
                  relationCards: createSampleRelationCards(slices),
                },
              })
            )
          )
        )
      )
      // JSDOM loads no subresources by default and does not execute fixture
      // scripts. Evaluate only the locally installed axe bundle in its realm.
      dom = new JSDOM(`<!doctype html>${html}`, { runScripts: "outside-only" })
      const { window } = dom
      failures.push(
        ...headingFailures(window.document).map(
          (failure) => `${prefix}: ${failure}`
        )
      )
      window.eval(axe.source)
      const result = await window.axe.run(window.document, {
        runOnly: {
          type: "tag",
          values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
        },
        // axe v4.13.0 documents that contrast is unsupported in JSDOM.
        rules: { "color-contrast": { enabled: false } },
        preload: false,
        resultTypes: ["violations", "incomplete"],
      })
      for (const violation of result.violations) {
        failures.push(
          `${prefix}: axe ${violation.id}: ${violation.help} (${violation.nodes.map((node) => node.target.join(" ")).join("; ")})`
        )
      }
      for (const incomplete of result.incomplete) {
        warnings.push(
          `${prefix}: axe ${incomplete.id} needs manual review (${incomplete.nodes.map((node) => node.target.join(" ")).join("; ")})`
        )
      }
      if (failures.length === before) checkedLocales.push(locale)
    } catch (error) {
      failures.push(
        `${prefix}: check failed: ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      dom?.window.close()
    }
  }
  return { failures, warnings, checkedLocales }
}
