import { postCards } from "@/test-utils/menu-visibility"
import { render, screen, within } from "@testing-library/react"
import type { ComponentPropsWithRef } from "react"
import { expect, test, vi } from "vitest"
import { Footer } from "./footer"

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: ComponentPropsWithRef<"a">) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

test("renders canonical panel and footer blocks in footer navigation", () => {
  render(
    <Footer
      footerMenu={{
        nav: [
          {
            id: "company",
            label: "Company",
            target: { type: "internal", url: "/company" },
            panel: {
              columns: 3,
              blocks: [
                {
                  id: "about-links",
                  kind: "linkGroup",
                  heading: "About",
                  links: [
                    {
                      id: "team",
                      label: "Team",
                      target: { type: "internal", url: "/team" },
                    },
                    {
                      id: "hidden",
                      label: "Hidden",
                      isDisabled: true,
                      target: { type: "internal", url: "/hidden" },
                    },
                  ],
                },
                {
                  id: "featured",
                  kind: "featured",
                  span: 2,
                  image: { alt: "" },
                  heading: "Launch guide",
                  description: "Start here",
                  target: {
                    type: "external",
                    url: "https://example.com/guide",
                    openInNewTab: false,
                  },
                },
              ],
              footer: {
                blocks: [
                  {
                    id: "legal",
                    kind: "linkGroup",
                    links: [
                      {
                        id: "privacy",
                        label: "Privacy",
                        target: { type: "internal", url: "/privacy" },
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
                      target: { type: "internal", url: "/posts" },
                    },
                  },
                ],
              },
            },
          },
        ],
      }}
      chrome={{ siteName: "Example" }}
      logoUrl={null}
      locale="en"
      defaultLocale="en"
      cardsBySource={postCards({ pageId: "post-1", title: "Latest post", href: "/latest-post" })}
    />
  )

  expect(
    screen.getAllByRole("heading").every((heading) => heading.tagName === "H2")
  ).toBe(true)
  const nav = screen.getByRole("navigation", { name: /footer navigation/i })
  expect(within(nav).getByRole("link", { name: "Company" })).toHaveAttribute(
    "href",
    "/company"
  )
  expect(within(nav).getByRole("link", { name: "Team" })).toHaveAttribute(
    "href",
    "/team"
  )
  expect(
    within(nav).getByRole("link", { name: /Launch guide/ })
  ).toHaveAttribute("href", "https://example.com/guide")
  expect(within(nav).getByRole("link", { name: "Privacy" })).toHaveAttribute(
    "href",
    "/privacy"
  )
  expect(
    within(nav).getByRole("link", { name: "Latest post" })
  ).toHaveAttribute("href", "/latest-post")
  expect(within(nav).getByRole("link", { name: "All posts" })).toHaveAttribute(
    "href",
    "/posts"
  )
  expect(within(nav).queryByText("Hidden")).toBeNull()
})

for (const withLink of [true, false]) {
  test(`empty lists in both footer regions leave only the item ${withLink ? "link" : "absent"}`, () => {
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
      <Footer
        chrome={null}
        logoUrl={null}
        locale="en"
        defaultLocale="en"
        footerMenu={{
          nav: [
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
          ],
        }}
      />
    )
    expect(screen.queryByText("Hidden heading")).toBeNull()
    expect(screen.queryByText("Hidden all")).toBeNull()
    if (withLink) {
      expect(
        screen.getByText("Empty panel").closest("li")!.querySelector("div")
      ).toBeNull()
      expect(screen.getByRole("link", { name: "Empty panel" })).toHaveAttribute(
        "href",
        "/fallback"
      )
    } else {
      expect(screen.queryByRole("link", { name: "Empty panel" })).toBeNull()
      expect(screen.queryByText("Empty panel")).toBeNull()
    }
  })
}

test.each(
  [Footer].flatMap((NavFooter, renderer) =>
    [1, 2, 3, 4].map((count) => ({ NavFooter, renderer, count }))
  )
)("R1a footer $count-column panel uses CSS only ($renderer)", ({ NavFooter, count }) => {
  render(
    <NavFooter
      chrome={{ siteName: "Example" }}
      logoUrl={null}
      locale="en"
      defaultLocale="en"
      footerMenu={{
        nav: [{
          id: "company",
          label: "Company",
          panel: {
            layout: "columns",
            columns: Array.from({ length: count }, (_, index) => ({
              id: `column-${index}`,
              blocks: [{
                id: `feature-${index}`,
                kind: "featured" as const,
                heading: `Card heading ${index}`,
                link: { label: `Read feature ${index}`, target: { type: "placeholder" as const, url: "#" } },
              }],
            })),
          },
        }],
      }}
    />
  )
  expect(screen.getByRole("link", { name: "Read feature 0" })).toHaveAttribute("href", "#")
  expect(screen.queryByRole("link", { name: "Card heading 0" })).toBeNull()
  const panel = screen.getByText("Company").closest("li")!
  expect(panel.querySelectorAll("[style]")).toHaveLength(0)
  const columns = panel.querySelector(".col-span-full")!
  expect(columns).toHaveClass("grid", "grid-cols-1")
  expect(columns.children).toHaveLength(count)
  if (count >= 2) expect(columns).toHaveClass("sm:grid-cols-2")
  if (count >= 3) expect(columns).toHaveClass(`lg:grid-cols-${count}`)
})
