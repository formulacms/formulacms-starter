import { decideMenu } from "@/lib/admin/menu/public-visibility"
import type { CanonicalResolvedNavItem as RawNavItem } from "@/convex/lib/menu"
import { postCards } from "@/test-utils/menu-visibility"
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, test, vi } from "vitest"
import type { CanonicalResolvedNavItem } from "@/convex/lib/menu"

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => "/fr/services",
}))

vi.mock("@/components/public/header-auth-controls", () => ({
  HeaderAuthControls: () => null,
}))

import { MobileNav as ClientMobileNav } from "./mobile-nav"
import { PresentationLocaleProvider } from "@/components/public/presentation-locale"

function withPolicy(Nav: typeof ClientMobileNav) {
  return function AdmittedNav({ items, cardsBySource = {}, ...props }:
    Omit<Parameters<typeof Nav>[0], "items"> & { items: RawNavItem[] }) {
    return <Nav {...props} items={decideMenu(items, cardsBySource).items} cardsBySource={cardsBySource} />
  }
}
const MobileNav = withPolicy(ClientMobileNav)

const resolvedMenu: CanonicalResolvedNavItem[] = [
  {
    id: "services",
    label: "Services en fran\u00e7ais",
    target: {
      type: "internal",
      url: "/fr/services",
    },
    panel: {
      columns: 1,
      blocks: [
        {
          id: "expertise",
          kind: "linkGroup",
          heading: "Expertise",
          links: [
            {
              id: "consulting",
              icon: "Briefcase",
              description: "Advice for complex launches",
              label: "Conseil",
              target: { type: "internal", url: "/fr/services/conseil" },
            },
            {
              id: "delivery",
              label: "Livraison",
              target: { type: "internal", url: "/fr/services/livraison" },
            },
          ],
        },
        {
          id: "resources",
          kind: "linkGroup",
          heading: "Ressources",
          links: [
            {
              id: "guide",
              label: "Guide pratique",
              target: {
                type: "external",
                url: "https://example.com/guide",
                openInNewTab: false,
              },
            },
          ],
        },
      ],
      footer: {
        blocks: [
          {
            id: "support",
            kind: "linkGroup",
            heading: "Assistance",
            links: [
              {
                id: "help",
                label: "Centre d’aide",
                target: { type: "internal", url: "/fr/aide" },
              },
            ],
          },
          {
            id: "recent",
            kind: "dynamicList",
            heading: "Publications récentes",
            source: { pageType: "post", limit: 2 },
            seeAll: {
              label: "Toutes les publications",
              target: { type: "internal", url: "/fr/publications" },
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

function renderMobileNav() {
  return render(
    <MobileNav
      items={resolvedMenu}
      cardsBySource={postCards({ pageId: "post-1", title: "Dernière publication", href: "/fr/derniere-publication" })}
    />
  )
}

function openSheet() {
  const trigger = screen.getByRole("button", { name: "Open menu" })
  fireEvent.click(trigger)
  return trigger
}

function expandServices() {
  const trigger = screen.getByRole("button", {
    name: "Services en fran\u00e7ais",
  })
  fireEvent.click(trigger)
  return trigger
}

describe("MobileNav canonical resolved menu tree", () => {
  test("renders panel descendants through an accessible accordion", () => {
    renderMobileNav()
    openSheet()

    const panelTrigger = screen.getByRole("button", {
      name: "Services en fran\u00e7ais",
    })
    expect(panelTrigger).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByRole("link", { name: "Conseil" })).toBeNull()

    fireEvent.click(panelTrigger)

    expect(panelTrigger).toHaveAttribute("aria-expanded", "true")
    expect(
      screen.getByRole("region", { name: "Services en fran\u00e7ais" })
    ).toBeVisible()
    expect(screen.getByRole("link", { name: /^Conseil/ })).toHaveAttribute(
      "href",
      "/fr/services/conseil"
    )
  })

  test("uses the localized parent label for the first navigable panel link", () => {
    renderMobileNav()
    openSheet()
    expandServices()

    const panel = screen.getByRole("region", {
      name: "Services en fran\u00e7ais",
    })
    const links = within(panel).getAllByRole("link")

    expect(links[0]).toHaveAccessibleName("Services en fran\u00e7ais")
    expect(links[0]).toHaveAttribute("href", "/fr/services")
    expect(within(panel).getByRole("link", { name: /^Conseil/ })).toBeVisible()
  })

  test("keeps each descendant section in a labelled semantic list", () => {
    renderMobileNav()
    openSheet()
    expandServices()

    const expertise = screen.getByRole("list", { name: "Expertise" })
    const resources = screen.getByRole("list", { name: "Ressources" })
    const support = screen.getByRole("list", { name: "Assistance" })

    expect(within(expertise).getAllByRole("listitem")).toHaveLength(2)
    expect(within(resources).getAllByRole("listitem")).toHaveLength(1)
    expect(
      within(support).getByRole("link", { name: "Centre d’aide" })
    ).toHaveAttribute("href", "/fr/aide")
    expect(
      within(expertise).getByRole("link", { name: /^Conseil/ })
    ).toBeVisible()
    expect(
      within(resources).getByRole("link", { name: "Guide pratique" })
    ).toBeVisible()
  })

  test("uses native buttons for keyboard actions and returns focus after Escape", async () => {
    renderMobileNav()
    const sheetTrigger = openSheet()

    const panelTrigger = screen.getByRole("button", {
      name: "Services en fran\u00e7ais",
    })
    expect(panelTrigger.tagName).toBe("BUTTON")

    panelTrigger.focus()
    expect(panelTrigger).toHaveFocus()
    fireEvent.click(panelTrigger)
    expect(panelTrigger).toHaveAttribute("aria-expanded", "true")

    fireEvent.keyDown(document, { key: "Escape" })

    await waitFor(() => {
      expect(
        screen.queryByRole("navigation", { name: "Site navigation" })
      ).toBeNull()
      expect(sheetTrigger).toHaveFocus()
    })
  })

  test("renders hydrated dynamic-list cards and see-all links", () => {
    renderMobileNav()
    openSheet()
    expandServices()

    expect(
      screen.getByRole("link", { name: "Dernière publication" })
    ).toHaveAttribute("href", "/fr/derniere-publication")
    expect(
      screen.getByRole("link", { name: "Toutes les publications" })
    ).toHaveAttribute("href", "/fr/publications")
  })
})

test("frame path suppresses the router's active mobile link for an unpublished Page", async () => {
  render(
    <PresentationLocaleProvider
      value={{ locale: "fr", defaultLocale: "en", publicPath: null }}
    >
      <MobileNav
        items={[
          {
            id: "services",
            label: "Services",
            target: { type: "internal", url: "/fr/services" },
          },
        ]}
      />
    </PresentationLocaleProvider>
  )
  fireEvent.click(screen.getByRole("button"))
  expect(
    await screen.findByRole("link", { name: "Services" })
  ).not.toHaveAttribute("aria-current")
})

test("unpublished frame never presents mobile root Home as current", async () => {
  render(
    <PresentationLocaleProvider
      value={{ locale: "en", defaultLocale: "en", publicPath: null }}
    >
      <MobileNav
        items={[
          { id: "home", label: "Home", target: { type: "internal", url: "/" } },
        ]}
      />
    </PresentationLocaleProvider>
  )
  fireEvent.click(screen.getByRole("button"))
  expect(await screen.findByRole("link", { name: "Home" })).not.toHaveAttribute(
    "aria-current"
  )
})

test("RF3 mounts the accessible sheet title inside its dialog only", () => {
  renderMobileNav()
  expect(screen.queryByRole("heading", { name: "Navigation menu" })).toBeNull()
  openSheet()
  const dialog = screen.getByRole("dialog")
  const title = within(dialog).getByRole("heading", { name: "Navigation menu" })
  expect(dialog).toHaveAccessibleName(title.textContent ?? "")
  expect(title.closest('[role="dialog"]')).toBe(dialog)
})

for (const withLink of [true, false]) {
  test(`empty automatic lists never produce an accordion (${withLink ? "link" : "absent"})`, () => {
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
      <MobileNav
        items={[
          {
            id: "item",
            label: "Empty panel",
            target: withLink
              ? { type: "internal", url: "/fallback" }
              : undefined,
            panel: {
              columns: 1,
              blocks: [empty],
              footer: { blocks: [{ ...empty, id: "bottom" }] },
            },
          },
        ]}
      />
    )
    openSheet()
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

test.each([MobileNav])("R1a mobile column panel stacks in order without menu styles (%#)", Nav => {
  render(<Nav items={[{ id: "services", label: "Services en français", panel: { layout: "columns", columns: [
    { id: "left", blocks: [{ id: "feature", kind: "featured", heading: "Card heading", link: { label: "Read feature", target: { type: "placeholder", url: "#" } } }] },
    { id: "right", blocks: [{ id: "links", kind: "linkGroup", links: [{ id: "child", label: "Second column", target: { type: "placeholder", url: "#" } }] }] },
  ] } }]} />)
  openSheet()
  const trigger = expandServices()
  expect(screen.getByRole("link", { name: "Read feature" })).toHaveAttribute("href", "#")
  expect(screen.queryByRole("link", { name: "Card heading" })).toBeNull()
  // Radix owns the accordion shell's animation styles; inspect authored panel content.
  const panel = document.getElementById(trigger.getAttribute("aria-controls")!)!.firstElementChild!
  expect(panel).not.toHaveAttribute("style")
  expect(panel.querySelectorAll("[style]")).toHaveLength(0)
  const columns = panel.firstElementChild!
  expect(columns).toHaveClass("flex", "flex-col")
  expect(columns.children).toHaveLength(2)
  expect(columns.children[0]).toHaveTextContent("Read feature")
  expect(columns.children[1]).toHaveTextContent("Second column")
})
