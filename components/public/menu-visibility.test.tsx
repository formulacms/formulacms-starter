import { placeholderTarget as target, postCards } from "@/test-utils/menu-visibility"
/// <reference types="vite/client" />
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import type { ComponentPropsWithRef } from "react"
import { afterEach, expect, test, vi } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"
import { convexTest } from "@/convexTestWithExplicitAdmin"
import { api } from "@/convex/_generated/api"
import schema from "@/convex/schema"
import {
  panelBlocks,
  dynamicListSourceKey,
  type CanonicalResolvedNavItem,
  type MenuCardsBySource,
} from "@/convex/lib/menu"
import * as visibility from "@/lib/admin/menu/public-visibility"
import { SiteHeader } from "./site-header"
import { Footer } from "./footer"

vi.mock("next/navigation", () => ({ usePathname: () => "/", useSearchParams: () => new URLSearchParams() }))
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: ComponentPropsWithRef<"a">) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))
vi.mock("@/components/public/header-auth-controls", () => ({
  HeaderAuthControls: () => null,
}))
vi.mock("@/components/public/navigation/locale-switcher", () => ({ LocaleSwitcher: () => null }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
const modules = import.meta.glob("../../convex/**/*.ts")
const surfaces = ["main", "mobile", "footer"] as const

const cards: MenuCardsBySource = postCards({ pageId: "post", title: "Published post", href: "/post" })
const fixture: CanonicalResolvedNavItem[] = [
  { id: "unresolved", label: "Unpublished item", target: { type: "internal" } },
  { id: "disabled", label: "Disabled item", target, isDisabled: true },
  { id: "placeholder", label: "Placeholder", target },
  { id: "empty", label: "Empty item", panel: { columns: 1, blocks: [] } },
  {
    id: "panel",
    label: "Panel",
    target: { type: "internal", url: "/panel" },
    panel: {
      layout: "columns",
      columns: [
        {
          id: "empty-col",
          blocks: [
            {
              id: "empty-list",
              kind: "dynamicList",
              source: { pageType: "empty", limit: 2 },
              seeAll: { label: "Suppressed all", target },
            },
          ],
        },
        {
          id: "col",
          blocks: [
            {
              id: "group",
              kind: "linkGroup",
              links: [
                {
                  id: "good",
                  label: "Good link",
                  target: { type: "internal", url: "/good" },
                },
                {
                  id: "bad",
                  label: "Unpublished child",
                  target: { type: "internal" },
                },
                {
                  id: "off",
                  label: "Disabled child",
                  target,
                  isDisabled: true,
                },
              ],
            },
            {
              id: "feature",
              kind: "featured",
              heading: "Content card",
              link: {
                label: "Featured link",
                target: { type: "internal", url: "/featured" },
              },
            },
          ],
        },
      ],
      footer: {
        blocks: [
          {
            id: "list",
            kind: "dynamicList",
            source: { pageType: "post", limit: 2 },
            seeAll: {
              label: "All posts",
              target: { type: "internal", url: "/posts" },
            },
          },
        ],
      },
    },
  },
]

function mount(
  surface: (typeof surfaces)[number],
  items: CanonicalResolvedNavItem[],
  cardsBySource: MenuCardsBySource = {}
) {
  if (surface === "footer") {
    render(
      <Footer
        footerMenu={{ nav: items }}
        chrome={null}
        logoUrl={null}
        locale="en"
        defaultLocale="en"
        cardsBySource={cardsBySource}
      />
    )
    return screen.queryByRole("navigation", { name: "Footer navigation" })
  }
  render(<SiteHeader logoUrl={null} mainMenuItems={items} locale="en" defaultLocale="en" enabledLocales={["en"]} languageVersion={1} cardsBySource={cardsBySource} />)
  if (surface === "mobile")
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }))
  const nav = screen.getByRole("navigation", {
    name: surface === "main" ? "Main navigation" : "Site navigation",
  })
  const panel = within(nav).queryByRole("button", { name: "Panel" })
  if (panel) {
    panel.focus()
    fireEvent.click(panel)
  }
  return nav
}
function links(
  items: visibility.ShownNavItem[],
  cardsBySource: MenuCardsBySource
): string[] {
  const result: string[] = []
  for (const item of items) {
    if (item.target) result.push(item.target.url)
    for (const { block } of panelBlocks(item.panel)) {
      if (block.kind === "linkGroup")
        result.push(...block.links.map((link) => link.target.url))
      else if (block.kind === "featured") {
        if (block.target) result.push(block.target.url)
        if (block.link) result.push(block.link.target.url)
      } else {
        result.push(
          ...(
            cardsBySource[dynamicListSourceKey(block.source)] ??
            []
          ).map((card) => card.href!)
        )
        if (block.seeAll) result.push(block.seeAll.target.url)
      }
    }
  }
  return result.sort()
}

test.each(
  surfaces.flatMap((surface) =>
    ["original", "unresolved overview", "unresolved legacy card"].map(
      (scenario) => ({ surface, scenario })
    )
  )
)(
  "$surface rendered link set equals the same policy fixture ($scenario)",
  ({ surface, scenario }) => {
    const items = structuredClone(fixture)
    const panel = items.find((item) => item.id === "panel")!
    if (scenario === "unresolved overview") panel.target = { type: "internal" }
    if (scenario === "unresolved legacy card")
      for (const { block } of panelBlocks(panel.panel))
        if (block.kind === "featured") {
          delete block.link
          block.target = { type: "internal" }
        }
    const expected = visibility.decideMenu(items, cards)
    const nav = mount(surface, items, cards)!
    expect(within(nav).getByRole("link", { name: "Good link" })).toBeVisible()
    expect(within(nav).getByText("Content card")).toBeVisible()
    if (scenario === "unresolved legacy card")
      expect(within(nav).getByText("Content card").closest("a")).toBeNull()
    if (scenario === "unresolved overview")
      expect(within(nav).queryByRole("link", { name: "Panel" })).toBeNull()
    expect(
      Array.from(nav.querySelectorAll("a"))
        .map((a) => a.getAttribute("href"))
        .sort()
    ).toEqual(links(expected.items, cards))
    for (const label of [
      "Unpublished item",
      "Disabled item",
      "Empty item",
      "Unpublished child",
      "Disabled child",
      "Suppressed all",
    ])
      expect(screen.queryByText(label)).toBeNull()
    expect(
      within(nav).getByRole("link", { name: "Placeholder" })
    ).toHaveAttribute("href", "#")
  }
)

test.each(surfaces)(
  "%s trusts policy output instead of filtering disabled links again",
  (surface) => {
    const supplied: visibility.ShownNavItem[] = [
      {
        id: "panel",
        label: "Panel",
        target,
        isDisabled: true,
        panel: {
          columns: 1,
          blocks: [
            {
              id: "group",
              kind: "linkGroup",
              links: [
                {
                  id: "child",
                  label: "Policy owns this",
                  target,
                  isDisabled: true,
                },
              ],
            },
          ],
        },
      },
    ]
    const decide = vi.spyOn(visibility, "decideMenu").mockReturnValue({
      items: supplied,
      nodes: new Map(),
    })
    const nav = mount(surface, supplied)!
    expect(decide).toHaveBeenCalledTimes(1)
    expect(
      within(nav).getByRole("link", { name: "Policy owns this" })
    ).toHaveAttribute("href", "#")
  }
)

test.each(
  surfaces.flatMap((surface) =>
    [false, true].map((withPanel) => ({ surface, withPanel }))
  )
)(
  "$surface real getWithResolvedLinks resolves FR-only own target (panel=$withPanel)",
  async ({ surface, withPanel }) => {
    const identity = {
      subject: "visibility-owner",
      tokenIdentifier: "https://convex.test|visibility-owner",
    }
    const t = convexTest({
      schema,
      modules,
      ownerIdentity: identity,
      publicationAuthority: "missing",
    })
    const owner = t.withIdentity(identity)
    await owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Visibility seam",
      timezone: "UTC",
      defaultLocale: "fr",
    })
    const changes = [{ moduleId: "multilingual", enabled: true }]
    const preview = await owner.query(api.cms.modules.preview, { changes })
    await owner.mutation(api.cms.modules.commit, {
      changes,
      expectedConfigurationVersion: preview.configurationVersion,
    })
    const { commandTokens } = await owner.query(
      api.cms.multilingual.getMultilingualState,
      {}
    )
    if (commandTokens.settingsUpdatedAt === null)
      throw new Error("Missing settings")
    await owner.mutation(api.cms.multilingual.addSiteLanguage, {
      locale: "en",
      expectedSettingsUpdatedAt: commandTokens.settingsUpdatedAt,
      expectedModuleConfigurationVersion:
        commandTokens.moduleConfigurationVersion,
      expectedAuthorityVersion: commandTokens.authorityVersion,
    })
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      defaultLocale: "fr",
      slug: "visible-fr",
      title: "FR page",
    })
    await owner.mutation(api.cms.publication.saveEditorDraft, {
      pageId,
      expectedLifecycleGeneration: 1,
      localized: {
        locale: "fr",
        slug: "visible-fr",
        expectedGeneration: 1,
        draft: {
          pageType: "landing-page",
          localized: { title: "FR page" },
          slices: [],
        },
      },
    })
    await owner.mutation(api.cms.publication.publishLocale, {
      pageId,
      locale: "fr",
      expectedDraftGeneration: 2,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })
    // Only fixture storage is written; the public query and policy are read-only.
    await t.run((ctx) =>
      ctx.db.insert("menus", {
        slug: "primary",
        updatedAt: 1,
        nav: [
          {
            id: "only-fr",
            label: withPanel
              ? { fr: "Panel", en: "Panel" }
              : { fr: "Publié FR", en: "Unpublished EN" },
            target: { type: "internal", pageId },
            ...(withPanel
              ? {
                  panel: {
                    columns: 1 as const,
                    blocks: [
                      {
                        id: "children",
                        kind: "linkGroup" as const,
                        links: [
                          {
                            id: "child",
                            label: { fr: "Panel child", en: "Panel child" },
                            target: { type: "placeholder" as const },
                          },
                        ],
                      },
                    ],
                  },
                }
              : {}),
          },
        ],
      })
    )
    const config = await owner.query(api.cms.settings.getSiteConfig, {})
    for (const locale of ["fr", "en"]) {
      const resolved = await t.query(api.cms.menus.getWithResolvedLinks, {
        slug: "primary",
        locale,
        languageVersion: config.languageVersion,
      })
      expect(resolved!.nav).toHaveLength(1)
      const decision = visibility.decideMenu(
        resolved!.nav,
        {}
      )
      expect(decision.nodes.get("only-fr")).toEqual({
        kind: "item",
        shown: withPanel || locale === "fr",
        reason: withPanel || locale === "fr" ? null : "No address",
      })
      const nav = mount(surface, resolved!.nav)
      if (withPanel) {
        expect(decision.nodes.get("only-fr:target")).toEqual({
          kind: "link",
          shown: locale === "fr",
          reason: locale === "fr" ? null : "No address",
        })
        const child = within(nav!).getByRole("link", { name: "Panel child" })
        expect(child).toHaveAttribute("href", "#")
        expect(child).toBeVisible()
        if (locale === "fr") {
          expect(decision.items[0]).toHaveProperty("target.url", "/visible-fr")
          expect(
            within(nav!).getByRole("link", { name: "Panel" })
          ).toHaveAttribute("href", "/visible-fr")
        } else {
          expect(decision.items[0]).not.toHaveProperty("target")
          expect(within(nav!).queryByRole("link", { name: "Panel" })).toBeNull()
          if (surface !== "footer") {
            const content = child.closest(
              '[data-slot="navigation-menu-content"], [data-slot="accordion-content"]'
            )
            expect(content).not.toBeNull()
            expect(
              within(content as HTMLElement).queryByText("Panel")
            ).toBeNull()
          }
          expect(
            Array.from(nav!.querySelectorAll("span")).filter(
              (span) => span.textContent === "Panel"
            )
          ).toEqual([])
        }
      } else if (locale === "fr")
        expect(screen.getByRole("link", { name: "Publié FR" })).toHaveAttribute(
          "href",
          "/visible-fr"
        )
      else {
        expect(decision.items).toEqual([])
        expect(screen.queryByText("Unpublished EN")).toBeNull()
        expect(document.body.textContent).not.toContain("Unpublished EN")
      }
      cleanup()
    }
  }
)

// Inspect import syntax so mixed { type T } and import type remain allowed.
test("public client files never value-import the server visibility policy or URL guard", () => {
  const violations: string[] = []
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) { visit(path); continue }
      if (!/\.tsx?$/.test(path)) continue
      const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)
      if (!file.statements.some((node) => ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text === "use client")) continue
      for (const node of file.statements) {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || !/(?:public-visibility|urlGuard)(?:\.[cm]?[jt]sx?)?$/.test(node.moduleSpecifier.text)) continue
        const clause = node.importClause
        const bindings = clause?.namedBindings
        const typeOnly = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((entry) => entry.isTypeOnly))
        if (!typeOnly) violations.push(path)
      }
    }
  }
  visit(resolve(process.cwd(), "components/public"))
  expect(violations).toEqual([])
})
