import mainNavSource from "./main-nav.tsx?raw"
import { postCards } from "@/test-utils/menu-visibility"
import { decideMenu } from "@/lib/admin/menu/public-visibility"
import type { CanonicalResolvedNavItem as RawNavItem } from "@/convex/lib/menu"
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import type { ComponentPropsWithRef } from "react"
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  pathname: "/fr/contact",
}))

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}))

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: ComponentPropsWithRef<"a">) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

import { MainNav as ClientMainNav } from "./main-nav"
import { PresentationLocaleProvider } from "@/components/public/presentation-locale"

function withPolicy(Nav: typeof ClientMainNav) {
  return function AdmittedNav({ items, cardsBySource = {}, ...props }:
    Omit<Parameters<typeof Nav>[0], "items"> & { items: RawNavItem[] }) {
    return <Nav {...props} items={decideMenu(items, cardsBySource).items} cardsBySource={cardsBySource} />
  }
}
const MainNav = withPolicy(ClientMainNav)

const items: Parameters<typeof MainNav>[0]["items"] = [
  {
    id: "home",
    label: "Accueil",
    target: {
      type: "internal",
      url: "/fr",
    },
  },
  {
    id: "products",
    label: "Produits",
    target: {
      type: "internal",
      url: "/fr/produits",
    },
    panel: {
      columns: 3,
      blocks: [
        {
          id: "discover",
          kind: "linkGroup",
          span: 2,
          heading: "Découvrir",
          links: [
            {
              id: "new-products",
              label: "Nouveautés",
              target: {
                type: "internal",
                url: "/fr/produits/nouveautes",
              },
            },
          ],
        },
        {
          id: "spotlight",
          kind: "featured",
          image: { alt: "Spotlight" },
          heading: "Spotlight",
          description: "A featured destination",
          target: { type: "internal", url: "/fr/produits/spotlight" },
        },
      ],
      footer: {
        blocks: [
          {
            id: "learn",
            kind: "linkGroup",
            heading: "Learn",
            links: [
              {
                id: "docs",
                label: "Documentation",
                target: { type: "internal", url: "/fr/docs" },
              },
            ],
          },
          {
            id: "recent",
            kind: "dynamicList",
            heading: "Recent posts",
            source: { pageType: "post", limit: 2 },
            seeAll: {
              label: "All posts",
              target: { type: "internal", url: "/fr/posts" },
            },
          },
        ],
      },
    },
  },
  {
    id: "contact",
    label: "Contact",
    target: {
      type: "internal",
      url: "/fr/contact",
    },
  },
]

function renderNav() {
  return render(
    <MainNav
      items={items}
      cardsBySource={postCards({ pageId: "post-1", title: "Latest post", excerpt: "A recent story", href: "/fr/latest-post" })}
    />
  )
}

function openProductsPanel() {
  const trigger = screen.getByRole("button", { name: "Produits" })
  trigger.focus()
  fireEvent.click(trigger)
  return trigger
}

function getOpenPanel(trigger: HTMLElement) {
  const panelId = trigger.getAttribute("aria-controls")
  expect(panelId).toBeTruthy()
  const panel = document.getElementById(panelId!)
  expect(panel).not.toBeNull()
  return panel!
}

describe("MainNav", () => {
  beforeEach(() => {
    mocks.pathname = "/fr/contact"
  })

  test("renders the Radix navigation path with named list semantics and current-page state", () => {
    renderNav()

    const nav = screen.getByRole("navigation", { name: /main navigation/i })
    expect(nav).toHaveAttribute("data-slot", "navigation-menu")

    const topLevelList = within(nav).getByRole("list")
    expect(topLevelList).toHaveAttribute("data-slot", "navigation-menu-list")
    expect(within(topLevelList).getAllByRole("listitem")).toHaveLength(3)
    expect(screen.getByRole("link", { name: "Contact" })).toHaveAttribute(
      "aria-current",
      "page"
    )
  })

  test("uses the panel trigger only to open and puts the parent's localized link first", () => {
    mocks.pathname = "/fr/produits"
    renderNav()

    expect(screen.queryByRole("link", { name: "Produits" })).toBeNull()

    const trigger = openProductsPanel()
    expect(trigger).toHaveAttribute("data-state", "open")
    expect(trigger).toHaveAttribute("aria-expanded", "true")
    expect(trigger).not.toHaveAttribute("href")

    const panel = getOpenPanel(trigger)
    const panelLinks = within(panel).getAllByRole("link")
    expect(panelLinks[0]).toHaveAccessibleName("Produits")
    expect(panelLinks[0]).toHaveAttribute("href", "/fr/produits")
    expect(panelLinks[0]).toHaveAttribute("aria-current", "page")
    expect(
      within(panel).getByRole("group", { name: "Découvrir" })
    ).toBeInTheDocument()
  })

  test("closes an open panel with Escape and restores focus to its trigger", async () => {
    renderNav()
    const trigger = openProductsPanel()
    const panel = getOpenPanel(trigger)
    const panelLink = within(panel).getByRole("link", { name: "Nouveautés" })

    panelLink.focus()
    expect(panelLink).toHaveFocus()
    fireEvent.keyDown(document, { key: "Escape" })

    await waitFor(() => {
      expect(trigger).toHaveAttribute("data-state", "closed")
      expect(trigger).toHaveAttribute("aria-expanded", "false")
      expect(trigger).toHaveFocus()
    })
    expect(screen.queryByRole("link", { name: "Produits" })).toBeNull()
  })

  test("keeps the panel bounded, end-aligned, and above later page content", () => {
    renderNav()
    const panel = getOpenPanel(openProductsPanel())

    expect(panel).toHaveClass("max-w-content", "end-0", "start-auto", "z-50")
  })

  test("renders three-column span, featured, and footer compositions", () => {
    renderNav()
    const panel = getOpenPanel(openProductsPanel())
    expect(within(panel).getByRole("group", { name: "Découvrir" })).toHaveClass(
      "col-span-2"
    )
    expect(
      within(panel).getByRole("link", { name: /Spotlight/ })
    ).toHaveAttribute("href", "/fr/produits/spotlight")
    expect(within(panel).getByRole("group", { name: "Learn" })).toBeVisible()
    expect(
      within(panel).getByRole("link", { name: "Documentation" })
    ).toHaveAttribute("href", "/fr/docs")
    expect(
      within(panel).getByRole("link", { name: /Latest post/ })
    ).toHaveAttribute("href", "/fr/latest-post")
    expect(
      within(panel).getByRole("link", { name: "All posts" })
    ).toHaveAttribute("href", "/fr/posts")
  })
})

test("frame canonical path controls active navigation and null suppresses draft-only state", () => {
  mocks.pathname = "/admin/pages/page/live-frame/fr"
  const item = [
    {
      id: "home",
      label: "Home",
      target: { type: "internal" as const, url: "/" },
    },
    {
      id: "contact",
      label: "Contact",
      target: { type: "internal" as const, url: "/fr/contact" },
    },
  ]
  const view = render(
    <PresentationLocaleProvider
      value={{ locale: "fr", defaultLocale: "en", publicPath: "/fr/contact" }}
    >
      <MainNav items={item} />
    </PresentationLocaleProvider>
  )
  expect(screen.getByRole("link", { name: "Contact" })).toHaveAttribute(
    "aria-current",
    "page"
  )
  view.rerender(
    <PresentationLocaleProvider
      value={{ locale: "fr", defaultLocale: "en", publicPath: null }}
    >
      <MainNav items={item} />
    </PresentationLocaleProvider>
  )
  expect(screen.getByRole("link", { name: "Contact" })).not.toHaveAttribute(
    "aria-current"
  )
})

test("unpublished frame never presents root Home as current", () => {
  render(
    <PresentationLocaleProvider
      value={{ locale: "en", defaultLocale: "en", publicPath: null }}
    >
      <MainNav
        items={[
          { id: "home", label: "Home", target: { type: "internal", url: "/" } },
        ]}
      />
    </PresentationLocaleProvider>
  )
  expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute(
    "aria-current"
  )
})

for (const withLink of [true, false]) {
  test(`hides empty lists in both regions and renders all-hidden panel as ${withLink ? "link" : "absent"}`, () => {
    const empty = {
      id: "empty",
      kind: "dynamicList" as const,
      heading: "Hidden heading",
      source: { pageType: "post" as const, limit: 3 },
      seeAll: {
        label: "Hidden all",
        target: { type: "internal" as const, url: "/posts" },
      },
    }
    render(
      <MainNav
        items={[
          {
            id: "item",
            label: "Empty panel",
            target: withLink
              ? { type: "internal", url: "/fallback" }
              : undefined,
            panel: {
              columns: 2,
              blocks: [empty],
              footer: { blocks: [{ ...empty, id: "bottom" }] },
            },
          },
        ]}
      />
    )
    expect(screen.queryByRole("button", { name: "Empty panel" })).toBeNull()
    expect(screen.queryByText("Hidden heading")).toBeNull()
    expect(screen.queryByText("Hidden all")).toBeNull()
    if (withLink)
      expect(screen.getByRole("link", { name: "Empty panel" })).toHaveAttribute(
        "href",
        "/fallback"
      )
    else {
      expect(screen.queryByRole("link", { name: "Empty panel" })).toBeNull()
      expect(screen.queryByText("Empty panel")).toBeNull()
    }
  })
}

test.each([1, 2, 3, 4] as const)(
  "panel width grows with %i columns and retains its caps",
  (columns) => {
    const original = items[1]!
    render(
      <MainNav
        items={[{ ...original, panel: { ...(original.panel! as Extract<NonNullable<(typeof items)[number]["panel"]>, { columns: number }>), columns } }]}
      />
    )
    const panel = getOpenPanel(openProductsPanel())
    expect(panel).toHaveClass(
      { 1: "w-64", 2: "w-128", 3: "w-192", 4: "w-256" }[columns]
    )
    expect(panel).toHaveClass("max-w-content", { 1: "md:w-64", 2: "md:w-128", 3: "md:w-192", 4: "md:w-256" }[columns])
    expect(panel.style.maxWidth).toBe("min(var(--container-content), calc(100vw - (var(--spacing-gutter) * 2)))")
  }
)

test.each([MainNav])("R1a column panels render stacked blocks and a featured Link (%#)", Nav => {
  render(<Nav items={[{ id: "products", label: "Produits", panel: { layout: "columns", columns: [
    { id: "left", blocks: [{ id: "feature", kind: "featured", heading: "Card heading", link: { label: "Read feature", target: { type: "placeholder", url: "#" } } }] },
    { id: "right", blocks: [{ id: "links", kind: "linkGroup", links: [{ id: "child", label: "Child", target: { type: "placeholder", url: "#" } }] }] },
  ] } }]} />)
  const panel = getOpenPanel(openProductsPanel())
  expect(screen.getByRole("link", { name: "Read feature" })).toHaveAttribute("href", "#")
  expect(screen.getByRole("link", { name: "Child" })).toHaveAttribute("href", "#")
  expect(screen.queryByRole("link", { name: "Card heading" })).toBeNull()
  expect(panel.style.length).toBe(1)
  expect(panel.style.maxWidth).toBe("min(var(--container-content), calc(100vw - (var(--spacing-gutter) * 2)))")
  expect(panel.querySelectorAll("[style]")).toHaveLength(0)
})


test("ED3 menu panel uses equivalent logical end/start placement", () => {
  expect(mainNavSource).toContain("end-0 start-auto z-50")
  expect(mainNavSource).not.toContain("right-0 left-auto z-50")
})
