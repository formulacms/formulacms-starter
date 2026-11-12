import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { NextIntlClientProvider } from "next-intl"
import type { ComponentProps } from "react"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import { SettingsPanel } from "./settings-panel"
import type { Page } from "../lib/types"
import type { Id } from "@/convex/_generated/dataModel"
import type { AddressAvailability } from "@/lib/admin/page-address-messages"
vi.mock("convex/react", () => ({
  useQuery: () => [],
  useMutation: () => vi.fn(),
}))
afterEach(cleanup)
const holder = {
  pageId: "holder" as Id<"pages">,
  pageType: "post",
  title: "Contact",
}
const availability: AddressAvailability = {
  parentChanged: false,
  entries: [
    {
      locale: "en",
      changed: true,
      check: { kind: "taken", locale: "en", path: "/contact", holder },
    },
  ],
}
const base: ComponentProps<typeof SettingsPanel> = {
  page: {
    _id: "edited" as Id<"pages">,
    _creationTime: 1,
    pageType: "page",
    status: "draft",
    slug: "support",
    createdAt: 1,
    updatedAt: 1,
    content: { en: { title: "Support", slices: [] } },
  } as Page,
  currentLocale: "en",
  defaultLocale: "en",
  title: "Support",
  slug: "contact",
  slugLinked: false,
  slugLocalizes: false,
  slugIsSaved: true,
  effectiveBaseSlug: "support",
  pageType: "page",
  parentId: "",
  authorIds: [],
  tags: [],
  parentOptions: [],
  fieldSourceTitle: "",
  fieldTranslate: undefined,
  fieldGenerate: undefined,
  onTitleChange: vi.fn(),
  onSlugChange: vi.fn(),
  onParentIdChange: vi.fn(),
  onAuthorIdsChange: vi.fn(),
  onTagsChange: vi.fn(),
  addressAvailability: availability,
}
function show(props: Partial<typeof base> = {}, admin: "en" | "fr" = "en") {
  return render(
    <NextIntlClientProvider locale={admin} messages={admin === "en" ? en : fr}>
      <SettingsPanel {...base} {...props} />
    </NextIntlClientProvider>
  )
}
test.each(["en", "fr"] as const)(
  "%s identifier refusal is last after hint/status, with accessible feedback",
  (admin) => {
    show(
      {
        currentLocale: "fr",
        slugLocalizes: true,
        slugIsSaved: false,
        addressAvailability: {
          ...availability,
          entries: [
            {
              locale: "fr",
              changed: true,
              check: { ...availability.entries[0]!.check, locale: "fr" },
            },
          ],
        },
      },
      admin
    )
    const message = screen.getByRole("alert")
    expect(message.textContent).toContain("/fr/contact")
    expect(message.previousElementSibling?.textContent).toContain("FR")
    expect(
      screen.getByLabelText(/URL|identifiant/i).getAttribute("maxlength")
    ).toBe("80")
  }
)
test("R3/R4: a parent change hides identifier feedback and keeps locale order under parent hint", () => {
  show({
    addressAvailability: {
      parentChanged: true,
      entries: [
        { ...availability.entries[0]!, parentTitle: "Services" },
        {
          locale: "fr",
          changed: true,
          parentTitle: "Prestations",
          check: {
            kind: "taken",
            locale: "fr",
            path: "/prestations/aide",
            holder: { ...holder, title: "Assistance" },
          },
        },
      ],
    },
  })
  const messages = screen.getAllByRole("alert")
  expect(messages).toHaveLength(2)
  expect(messages[0]?.textContent).toContain("Under “Services”")
  expect(messages[1]?.textContent).toContain("In French")
  expect(messages[0]?.previousElementSibling?.textContent).toBe(
    en.editor.settings.parentHint
  )
})
test("R2: allocation hint follows linked hint and disappears after manual change", () => {
  const props = {
    slug: "contact-2",
    slugLinked: true,
    addressAvailability: {
      parentChanged: false,
      entries: [
        {
          ...availability.entries[0]!,
          changed: false,
          check: { ...availability.entries[0]!.check, kind: "free" as const },
          allocation: {
            wantedSlug: "contact",
            allocatedSlug: "contact-2",
            check: availability.entries[0]!.check,
            newPath: "/contact-2",
          },
        },
      ],
    },
  }
  const result = show(props)
  expect(
    screen.getByText(/so this page uses/).previousElementSibling?.textContent
  ).toBe(en.editor.settings.slugLinkedHint)
  expect(screen.queryByRole("alert")).toBeNull()
  result.unmount()
  show({ ...props, addressWasTyped: true })
  expect(screen.queryByText(/so this page uses/)).toBeNull()
})
test("free and non-routable inputs add no new address messages", () => {
  show({
    addressAvailability: {
      parentChanged: false,
      entries: [
        {
          ...availability.entries[0]!,
          check: { ...availability.entries[0]!.check, kind: "free" },
        },
      ],
    },
  })
  expect(screen.queryByRole("alert")).toBeNull()
})

test.each(["en", "fr"] as const)(
  "%s Parent page lines put selected French first and preserve prefix without a lead-in",
  (admin) => {
    show(
      {
        currentLocale: "fr",
        addressAvailability: {
          parentChanged: true,
          entries: [
            { ...availability.entries[0]! },
            {
              locale: "fr",
              changed: true,
              check: { kind: "system", locale: "fr", path: "/admin" },
            },
          ],
        },
      },
      admin
    )
    const alerts = screen.getAllByRole("alert")
    expect(alerts).toHaveLength(2)
    expect(alerts[0]?.textContent).toContain("/fr/admin")
    expect(alerts[0]?.textContent).toBe(
      (admin === "en" ? en : fr).pageAddress.S3rd.replace("{path}", "/fr/admin")
    )
    expect(alerts[1]?.textContent).toContain("/contact")
    expect(alerts[0]?.previousElementSibling?.textContent).toBe(
      (admin === "en" ? en : fr).editor.settings.parentHint
    )
  }
)

test.each(["system", "language"] as const)(
  "%s numbered hint follows the linked hint only while identifier equals allocation",
  (kind) => {
    const wanted = kind === "system" ? "jobs" : "fr"
    const props = {
      slug: wanted + "-2",
      slugLinked: true,
      addressAvailability: {
        parentChanged: false,
        entries: [
          {
            locale: "en",
            changed: false,
            check: {
              kind: "free" as const,
              locale: "en",
              path: "/" + wanted + "-2",
            },
            allocation: {
              wantedSlug: wanted,
              allocatedSlug: wanted + "-2",
              newPath: "/" + wanted + "-2",
              check: {
                kind,
                locale: "en",
                path: "/" + wanted,
                reservedLocale: "fr",
              },
            },
          },
        ],
      },
    }
    const view = show(props)
    const hint = screen.getByText(/so this page uses/)
    expect(hint.previousElementSibling?.textContent).toBe(
      en.editor.settings.slugLinkedHint
    )
    expect(hint.className).toContain("text-muted-foreground")
    view.unmount()
    show({ ...props, slug: "custom" })
    expect(screen.queryByText(/so this page uses/)).toBeNull()
  }
)

test("Tags field shows on blog posts only", () => {
  const view = show({ addressAvailability: undefined })
  expect(screen.queryByLabelText(en.editor.settings.tags)).toBeNull()
  view.unmount()
  show({
    addressAvailability: undefined,
    pageType: "post",
    page: { ...base.page, pageType: "post" } as Page,
  })
  expect(screen.getByLabelText(en.editor.settings.tags)).toBeInTheDocument()
})
