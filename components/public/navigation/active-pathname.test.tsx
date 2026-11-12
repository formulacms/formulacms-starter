import type { ComponentPropsWithRef, ReactNode } from "react"
import { renderToString } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"
import type { ShownNavItem } from "@/lib/admin/menu/public-visibility"
import {
  PresentationLocaleProvider,
  type PresentationLocale,
} from "@/components/public/presentation-locale"

const route = vi.hoisted(() => ({ pathname: "/services" }))

vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }))
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: ComponentPropsWithRef<"a">) => (
    <a href={href} {...props}>{children}</a>
  ),
}))
vi.mock("@/components/public/header-auth-controls", () => ({
  HeaderAuthControls: () => null,
}))
// The real closed Sheet omits its portaled links during SSR. Expose that
// boundary to exercise MobileNav's own comparison; mobile-nav.test.tsx covers
// opening the real Sheet. Desktop keeps the real Radix active-link primitive.
vi.mock("@/components/ui/sheet", () => {
  const Boundary = ({ children }: { children: ReactNode }) => <>{children}</>
  return {
    Sheet: Boundary,
    SheetTrigger: Boundary,
    SheetContent: Boundary,
    SheetTitle: Boundary,
  }
})

import { MainNav } from "./main-nav"
import { MobileNav } from "../mobile-nav"

function link(id: string, url: string): ShownNavItem {
  return {
    id,
    label: id,
    target: { type: url.startsWith("https:") ? "external" : "internal", url },
  }
}

const items = [
  link("home", "/"),
  link("services", "/services"),
  link("french", "/fr/services"),
  link("prefixed", "/en/services"),
  link("external", "https://example.com/services"),
  link("hash", "#services"),
]

describe.each([
  ["desktop", MainNav],
  ["mobile", MobileNav],
] as const)("%s active pathname", (name, Nav) => {
  function markup(
    pathname: string,
    presentation: PresentationLocale = { locale: "en", defaultLocale: "en" },
    menu = items
  ) {
    route.pathname = pathname
    const html = renderToString(
      <PresentationLocaleProvider value={presentation}>
        <Nav items={menu} />
      </PresentationLocaleProvider>
    )
    const container = document.createElement("div")
    container.innerHTML = html
    return Array.from(container.querySelectorAll("a")).map((anchor) => ({
      label: anchor.textContent,
      href: anchor.getAttribute("href"),
      current: anchor.getAttribute("aria-current"),
      active: anchor.hasAttribute("data-active"),
    }))
  }

  test("default-locale prerender and browser select the same public link", () => {
    const server = markup("/en/services")
    expect(server).toEqual(markup("/services"))
    expect(server.filter((a) => a.current === "page")).toEqual([
      { label: "services", href: "/services", current: "page", active: name === "desktop" },
    ])
  })

  test("default-locale home is stable across the rewrite", () => {
    const server = markup("/en")
    expect(server).toEqual(markup("/"))
    expect(server.filter((a) => a.current === "page").map((a) => a.label)).toEqual(["home"])
  })

  test("retains trailing-slash and query/hash href comparisons", () => {
    const menu = [link("services", "/services/?view=all#details")]
    const server = markup("/en/services/", undefined, menu)
    expect(server).toEqual(markup("/services/", undefined, menu))
    expect(server[0].current).toBe("page")
  })

  test("non-default locale selects only its prefixed link", () => {
    const result = markup("/fr/services", { locale: "fr", defaultLocale: "en" })
    expect(result.filter((a) => a.current === "page").map((a) => a.label)).toEqual(["french"])
  })

  test("a preview publicPath wins verbatim over the private route", () => {
    const result = markup("/admin/pages/page/live-frame/en", {
      locale: "en", defaultLocale: "en", publicPath: "/en/services",
    })
    expect(result.filter((a) => a.current === "page").map((a) => a.label)).toEqual(["prefixed"])
  })

  test("null preview paths suppress active links including Home", () => {
    const result = markup("/en", { locale: "en", defaultLocale: "en", publicPath: null })
    expect(result.every((a) => a.current === null && !a.active)).toBe(true)
  })

  test("external and hash-only links never become active", () => {
    const result = markup("/services")
    expect(result.filter((a) => ["external", "hash"].includes(a.label ?? ""))).toEqual([
      { label: "external", href: "https://example.com/services", current: null, active: false },
      { label: "hash", href: "#services", current: null, active: false },
    ])
  })

  test("a slug beginning with the locale is not a locale segment", () => {
    const result = markup("/english/services", undefined, [link("english", "/english/services")])
    expect(result[0].current).toBe("page")
  })
})
