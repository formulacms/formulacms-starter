import { expectLegacyPanel as legacyPanel } from "@/test-utils/menu-panel"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, test, vi } from "vitest"
import { getFunctionName, type FunctionArgs } from "convex/server"
import type { api } from "@/convex/_generated/api"
import { localizeCanonicalNav } from "@/convex/lib/menu/canonical"
import type { NavItem } from "@/convex/lib/menu"
import { NextIntlClientProvider } from "next-intl"
import en from "@/messages/admin/en.json"
import { MenuEditor } from "./menu-editor"
import MenusPage from "@/app/(core)/admin/(authenticated)/menus/page"
import { toast } from "sonner"

const mocks = vi.hoisted(() => ({
  nav: [] as NavItem[],
  siteConfig: { enabledLocales: ["en", "fr"], defaultLocale: "en" } as { enabledLocales: string[]; defaultLocale: string } | undefined,
  menuLoaded: true,
  updatedAt: 1 as number | null,
  owner: undefined as
    | undefined
    | null
    | { ownerId: string; authId: string; email: string; role: "admin" },
  save: vi.fn(),
  useQuery: vi.fn(),
  confirm: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => mocks.confirm,
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.navigate }),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock("convex/react", () => ({
  useQuery: mocks.useQuery,
  useMutation: vi.fn((reference) => {
    expect(getFunctionName(reference)).toBe("cms/menus:saveCanonical")
    return mocks.save
  }),
}))

function renderEditor() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MenuEditor slug="primary" />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.mocked(toast.success).mockReset()
  vi.mocked(toast.error).mockReset()
  mocks.confirm.mockReset().mockResolvedValue(true)
  mocks.navigate.mockReset()
  mocks.siteConfig = { enabledLocales: ["en", "fr"], defaultLocale: "en" }
  mocks.menuLoaded = true
  mocks.updatedAt = 1
  mocks.nav = [
    { id: "first", label: { en: "First", fr: "Premier" } },
    { id: "later", label: { en: "Later" } },
  ]
  mocks.owner = {
    ownerId: "owner-1",
    authId: "owner-auth-1",
    email: "owner@example.com",
    role: "admin",
  }
  mocks.useQuery.mockReset().mockImplementation((reference, args) => {
    const name = getFunctionName(reference)
    if (name === "cms/owner:getOwnerSession") return mocks.owner
    if (name === "cms/settings:getSiteConfig") {
      return mocks.siteConfig
    }
    if (name === "cms/menus:getCanonical" && args === "skip") return undefined
    if (name === "cms/menus:getCanonical") {
      return !mocks.menuLoaded ? undefined : mocks.updatedAt === null ? null : { slug: "primary", nav: mocks.nav, updatedAt: mocks.updatedAt }
    }
    return undefined
  })
  mocks.save.mockReset().mockResolvedValue({ id: "menu-id", updatedAt: 2 })
})

test("permission loading starts no menu-content subscription or mutation controls", () => {
  mocks.owner = undefined
  renderEditor()
  expect(
    mocks.useQuery.mock.calls.some(
      ([reference, args]) =>
        getFunctionName(reference) === "cms/menus:getCanonical" &&
        args === "skip"
    )
  ).toBe(true)
  expect(screen.queryByRole("button", { name: /save menu/i })).toBeNull()
  expect(screen.queryByRole("button", { name: /copy from/i })).toBeNull()
})

test("an unrelated identity starts no menu-content subscription", () => {
  mocks.owner = null
  renderEditor()
  expect(screen.getByText(/do not have access to this menu/i)).toBeTruthy()
  expect(
    mocks.useQuery.mock.calls.some(
      ([reference, args]) =>
        getFunctionName(reference) === "cms/menus:getCanonical" &&
        args === "skip"
    )
  ).toBe(true)
})

test("the owner renders editable canonical panel content", () => {
  mocks.nav = [
    {
      id: "products",
      label: { en: "Products" },
      panel: {
        columns: 1,
        blocks: [
          {
            id: "featured-links",
            kind: "linkGroup",
            heading: { en: "Featured" },
            links: [
              {
                id: "launches",
                label: { en: "Launches" },
                target: { type: "external", url: "/launches" },
              },
            ],
          },
        ],
      },
    },
  ]
  renderEditor()
  expect(screen.getByDisplayValue("Products")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Expand item" }))
  expect(screen.getByDisplayValue("Featured")).toBeTruthy()
  expect(screen.getByDisplayValue("Launches")).toBeTruthy()
  expect(screen.getAllByRole("textbox").length).toBeGreaterThan(0)
  expect(
    mocks.useQuery.mock.calls.some(
      ([reference]) =>
        getFunctionName(reference) === "cms/pages:listLinkablePages"
    )
  ).toBe(false)
})

test("saves one canonical payload without locale rows or legacy items", async () => {
  renderEditor()
  fireEvent.change(
    screen.getAllByPlaceholderText("Navigation item label")[0]!,
    {
      target: { value: "Updated first" },
    }
  )
  fireEvent.click(screen.getByRole("button", { name: "Save menu" }))
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith({
      slug: "primary",
      locale: "en",
      expectedUpdatedAt: 1,
      nav: [
        { id: "first", label: { en: "Updated first", fr: "Premier" } },
        { id: "later", label: { en: "Later" } },
      ],
    })
  )
})

test("saving a Dutch-default tab leaves an untouched French label absent", async () => {
  mocks.siteConfig = {
    enabledLocales: ["nl", "fr"],
    defaultLocale: "nl",
  }
  mocks.nav = [
    { id: "first", label: { nl: "Eerste", fr: "Premier" } },
    { id: "later", label: { nl: "Later" } },
  ]
  renderEditor()
  fireEvent.click(screen.getByRole("tab", { name: "FR — Edit Français" }))
  const labels = screen.getAllByRole("textbox", {
    name: "Navigation item label",
  })
  expect(labels).toHaveLength(2)
  expect(labels[0]).toHaveValue("Premier")
  expect(labels[1]).toHaveValue("")
  expect(labels[1]).toHaveAttribute("placeholder", "Later")
  expect(screen.queryByText(/Empty fields show NL text/)).toBeNull()
  expect(
    screen.queryByRole("button", { name: /add navigation item/i })
  ).toBeNull()
  expect(screen.queryByRole("button", { name: /delete item/i })).toBeNull()

  fireEvent.change(labels[0]!, { target: { value: "Premier traduit" } })
  fireEvent.click(screen.getByRole("button", { name: "Save menu" }))
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith({
      slug: "primary",
      locale: "fr",
      expectedUpdatedAt: 1,
      nav: [
        { id: "first", label: { nl: "Eerste", fr: "Premier traduit" } },
        { id: "later", label: { nl: "Later" } },
      ],
    })
  )
})

test("saving a Dutch-default secondary tab omits blank text and preserves decorative alt", async () => {
  mocks.siteConfig = {
    enabledLocales: ["nl", "fr"],
    defaultLocale: "nl",
  }
  mocks.nav = [
    {
      id: "products",
      label: { nl: "Producten", fr: "Produits" },
      panel: {
        columns: 1,
        blocks: [
          {
            id: "featured",
            kind: "featured",
            image: {
              url: "https://example.com/feature.jpg",
              alt: { nl: "Omslag", fr: "" },
            },
            heading: { nl: "Uitgelicht", fr: "En vedette" },
            description: { nl: "Lees meer", fr: "En savoir plus" },
            target: { type: "external", url: "/producten" },
          },
        ],
      },
    },
  ]
  renderEditor()
  fireEvent.click(screen.getByRole("tab", { name: "FR — Edit Français" }))
  fireEvent.change(screen.getByDisplayValue("Produits"), {
    target: { value: "" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Expand item" }))
  fireEvent.change(screen.getByDisplayValue("En vedette"), {
    target: { value: "" },
  })
  fireEvent.change(screen.getByDisplayValue("En savoir plus"), {
    target: { value: "" },
  })
  expect(screen.getByLabelText("Image alt text")).toHaveValue("")
  expect(screen.getByLabelText("Image alt text")).toHaveAttribute(
    "placeholder",
    "Omslag"
  )
  fireEvent.click(screen.getByRole("button", { name: "Save menu" }))
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith({
      slug: "primary",
      locale: "fr",
      expectedUpdatedAt: 1,
      nav: [
        {
          id: "products",
          label: { nl: "Producten" },
          panel: {
            columns: 1,
            blocks: [
              {
                id: "featured",
                kind: "featured",
                image: {
                  url: "https://example.com/feature.jpg",
                  alt: { nl: "Omslag", fr: "" },
                },
                heading: { nl: "Uitgelicht" },
                description: { nl: "Lees meer" },
                target: { type: "external", url: "/producten" },
              },
            ],
          },
        },
      ],
    })
  )
})

test("copying Dutch text explicitly authors the secondary-language keys", async () => {
  mocks.siteConfig = {
    enabledLocales: ["nl", "fr"],
    defaultLocale: "nl",
  }
  mocks.nav = [
    { id: "first", label: { nl: "Eerste" } },
    { id: "later", label: { nl: "Later" } },
  ]
  renderEditor()
  fireEvent.click(screen.getByRole("tab", { name: "FR — Edit Français" }))
  fireEvent.keyDown(screen.getByRole("button", { name: "Copy from…" }), {
    key: "ArrowDown",
  })
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy from NL" }))
  expect(screen.getByDisplayValue("Eerste")).toBeTruthy()
  expect(screen.getByDisplayValue("Later")).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Save menu" }))
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith({
      slug: "primary",
      locale: "fr",
      expectedUpdatedAt: 1,
      nav: [
        { id: "first", label: { nl: "Eerste", fr: "Eerste" } },
        { id: "later", label: { nl: "Later", fr: "Later" } },
      ],
    })
  )
})

test("secondary locales use default structure and edit only localized leaves", async () => {
  renderEditor()
  fireEvent.click(screen.getByRole("tab", { name: "FR — Edit Français" }))
  const labels = screen.getAllByRole("textbox", {
    name: "Navigation item label",
  })
  fireEvent.change(labels[1]!, { target: { value: "Plus tard" } })
  fireEvent.click(screen.getByRole("button", { name: "Save menu" }))
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith({
      slug: "primary",
      locale: "fr",
      expectedUpdatedAt: 1,
      nav: [
        { id: "first", label: { en: "First", fr: "Premier" } },
        { id: "later", label: { en: "Later", fr: "Plus tard" } },
      ],
    })
  )
})

test("a missing canonical menu renders empty navigation and saves with its slug", async () => {
  const existingQuery = mocks.useQuery.getMockImplementation()!
  mocks.useQuery.mockImplementation((reference, args) =>
    getFunctionName(reference) === "cms/menus:getCanonical" && args !== "skip"
      ? null
      : existingQuery(reference, args)
  )
  renderEditor()
  expect(screen.queryByPlaceholderText("Navigation item label")).toBeNull()
  expect(screen.getByRole("button", { name: "Save menu" })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Add navigation item" }))
  fireEvent.change(screen.getByPlaceholderText("Navigation item label"), {
    target: { value: "First item" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Save menu" }))
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith({
      slug: "primary",
      locale: "en",
      expectedUpdatedAt: null,
      nav: [expect.objectContaining({ label: { en: "First item" } })],
    })
  )
})

type SavePayload = FunctionArgs<typeof api.cms.menus.saveCanonical>
type SaveAcknowledgement = { id: string; updatedAt: number }

// Model our token contract: a successful save advances storage, a refusal writes nothing.
function storeMenuSave(payload: SavePayload): SaveAcknowledgement {
  if (payload.expectedUpdatedAt !== mocks.updatedAt)
    throw new Error("Menu changed since editing started")
  mocks.updatedAt = (mocks.updatedAt ?? 0) + 1
  mocks.nav = structuredClone(payload.nav)
  return { id: "menu-id", updatedAt: mocks.updatedAt }
}

function pendingMenuSave() {
  let acknowledge!: (saved: SaveAcknowledgement) => void
  let refuse!: (error: Error) => void
  const pending = new Promise<SaveAcknowledgement>((resolve, reject) => {
    acknowledge = resolve
    refuse = reject
  })
  // Each guard lists exactly its two expected calls; a third call cannot silently pass.
  mocks.save
    .mockImplementation(() => {
      throw new Error("Unlisted menu save")
    })
    .mockImplementationOnce(() => pending)
    .mockImplementationOnce(storeMenuSave)
  return { acknowledge, refuse }
}

function editMenuLabel(from: string, to: string) {
  fireEvent.change(screen.getByDisplayValue(from), { target: { value: to } })
}

function clickSaveMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Save menu" }))
}

for (const scenario of [
  "existing-default",
  "existing-secondary",
  "first-save",
] as const) {
  test(`pending save continuation uses the acknowledged revision: ${scenario}`, async () => {
    const locale = scenario === "existing-secondary" ? "fr" : "en"
    if (scenario === "first-save") {
      mocks.updatedAt = null
      mocks.nav = []
    }
    const pending = pendingMenuSave()
    renderEditor()
    if (locale === "fr") {
      const tab = screen.getByRole("tab", { name: "FR — Edit Français" })
      expect(tab).toBeEnabled()
      fireEvent.click(tab)
      expect(tab).toHaveAttribute("aria-selected", "true")
    }
    if (scenario === "first-save") {
      fireEvent.click(
        screen.getByRole("button", { name: "Add navigation item" })
      )
      fireEvent.change(screen.getByPlaceholderText("Navigation item label"), {
        target: { value: "Submitted" },
      })
    } else editMenuLabel(locale === "fr" ? "Premier" : "First", "Submitted")
    clickSaveMenu()
    expect(mocks.save).toHaveBeenCalledTimes(1)
    const first: SavePayload = mocks.save.mock.calls[0]![0]
    expect(first).toMatchObject({
      locale,
      expectedUpdatedAt: scenario === "first-save" ? null : 1,
    })
    editMenuLabel("Submitted", "Newer draft")
    const acknowledged = storeMenuSave(first)
    expect(acknowledged.updatedAt).toBe(mocks.updatedAt)
    await act(async () => pending.acknowledge(acknowledged))
    expect(screen.getByDisplayValue("Newer draft")).toBeTruthy()
    clickSaveMenu()
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2))
    expect(mocks.save.mock.calls[1]![0]).toMatchObject({
      locale,
      expectedUpdatedAt: acknowledged.updatedAt,
    })
    expect(mocks.nav[0]!.label[locale]).toBe("Newer draft")
    expect(mocks.updatedAt).toBe(acknowledged.updatedAt + 1)
    expect(toast.error).not.toHaveBeenCalled()
  })
}

for (const locale of ["en", "fr"] as const) {
  function startPendingDraft() {
    const pending = pendingMenuSave()
    const view = renderEditor()
    if (locale === "fr")
      fireEvent.click(screen.getByRole("tab", { name: "FR — Edit Français" }))
    editMenuLabel(locale === "fr" ? "Premier" : "First", "Submitted")
    clickSaveMenu()
    editMenuLabel("Submitted", "Newer draft")
    return {
      ...pending,
      view,
      submitted: mocks.save.mock.calls[0]![0] as SavePayload,
    }
  }

  test(`acknowledged R2 never adopts reactive external R3: ${locale}`, async () => {
    const pending = startPendingDraft()
    const acknowledged = storeMenuSave(pending.submitted)
    expect(acknowledged.updatedAt).toBe(2)
    mocks.updatedAt = 3
    mocks.nav = [
      { id: "first", label: { en: "External", fr: "Externe" } },
      { id: "later", label: { en: "Later" } },
    ]
    rerenderEditor(pending.view) // R3 is visible to the query before R2 is acknowledged.
    await act(async () => pending.acknowledge(acknowledged))
    clickSaveMenu()
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Failed to save menu")
    )
    expect(mocks.save).toHaveBeenCalledTimes(2)
    expect(mocks.save.mock.calls[1]![0]).toMatchObject({
      locale,
      expectedUpdatedAt: 2,
    })
    expect(mocks.updatedAt).toBe(3)
    expect(mocks.nav[0]!.label[locale]).toBe(
      locale === "fr" ? "Externe" : "External"
    )
    expect(screen.getByDisplayValue("Newer draft")).toBeTruthy()
  })

  test(`edit queued after acknowledgement preserves its revision before state flush: ${locale}`, async () => {
    const pending = startPendingDraft()
    const acknowledged = storeMenuSave(pending.submitted)
    let editedBeforeFlush = false
    vi.mocked(toast.success).mockImplementationOnce(() => {
      // handleSave queues the acknowledgement before this callback and isSaving release.
      editedBeforeFlush = Boolean(screen.getByDisplayValue("Newer draft"))
      editMenuLabel("Newer draft", "Edited after acknowledgement")
      return "toast-id"
    })
    await act(async () => pending.acknowledge(acknowledged))
    expect(editedBeforeFlush).toBe(true)
    expect(
      screen.getByDisplayValue("Edited after acknowledgement")
    ).toBeTruthy()
    clickSaveMenu()
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2))
    expect(mocks.save.mock.calls[1]![0]).toMatchObject({
      locale,
      expectedUpdatedAt: acknowledged.updatedAt,
    })
    expect(mocks.nav[0]!.label[locale]).toBe("Edited after acknowledgement")
    expect(toast.error).not.toHaveBeenCalled()
  })

  test(`failed pending save keeps the original draft revision: ${locale}`, async () => {
    const pending = startPendingDraft()
    await act(async () => pending.refuse(new Error("save refused")))
    expect(screen.getByDisplayValue("Newer draft")).toBeTruthy()
    expect(mocks.updatedAt).toBe(1)
    clickSaveMenu()
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2))
    expect(mocks.save.mock.calls[1]![0]).toMatchObject({
      locale,
      expectedUpdatedAt: 1,
    })
    expect(mocks.nav[0]!.label[locale]).toBe("Newer draft")
    expect(toast.error).toHaveBeenCalledTimes(1)
  })
}

test("cancelled discard keeps values and token; confirmed discard clears them and next edit captures current revision", async () => {
  mocks.save
    .mockImplementation(() => {
      throw new Error("Unlisted menu save")
    })
    .mockImplementationOnce(storeMenuSave)
    .mockImplementationOnce(storeMenuSave)
  const view = renderEditor()
  editMenuLabel("First", "Retained draft")
  mocks.updatedAt = 3
  rerenderEditor(view)
  mocks.confirm.mockResolvedValueOnce(false)
  fireEvent.click(screen.getByRole("tab", { name: "FR — Edit Français" }))
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1))
  expect(screen.getByDisplayValue("Retained draft")).toBeTruthy()
  clickSaveMenu()
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith("Failed to save menu")
  )
  expect(mocks.save.mock.calls[0]![0]).toMatchObject({
    locale: "en",
    expectedUpdatedAt: 1,
  })
  expect(screen.getByDisplayValue("Retained draft")).toBeTruthy()
  mocks.confirm.mockResolvedValueOnce(true)
  fireEvent.click(screen.getByRole("tab", { name: "FR — Edit Français" }))
  await waitFor(() => expect(screen.getByDisplayValue("Premier")).toBeTruthy())
  expect(screen.queryByDisplayValue("Retained draft")).toBeNull()
  expect(screen.getByRole("button", { name: "Save menu" })).toBeDisabled()
  editMenuLabel("Premier", "Après abandon")
  clickSaveMenu()
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2))
  expect(mocks.save.mock.calls[1]![0]).toMatchObject({
    locale: "fr",
    expectedUpdatedAt: 3,
  })
  expect(mocks.nav[0]!.label.fr).toBe("Après abandon")
})

test("an unchanged submitted draft clears only after successful completion", async () => {
  let resolve!: () => void
  mocks.save.mockImplementationOnce(
    () =>
      new Promise<SaveAcknowledgement>((done) => {
        resolve = () => done({ id: "menu-id", updatedAt: 2 })
      })
  )
  renderEditor()
  fireEvent.change(screen.getByDisplayValue("First"), {
    target: { value: "Submitted" },
  })
  fireEvent.click(screen.getByRole("button", { name: "Save menu" }))
  mocks.nav = mocks.save.mock.calls[0]![0].nav
  await act(async () => resolve())
  expect(screen.getByRole("button", { name: "Save menu" })).toBeDisabled()
})

test("a synchronous localized merge refusal recovers saving state and keeps the draft", async () => {
  const view = renderEditor()
  fireEvent.click(screen.getByRole("tab", { name: "FR — Edit Français" }))
  fireEvent.change(screen.getByDisplayValue("Premier"), {
    target: { value: "Keep me" },
  })
  const original = mocks.nav
  mocks.nav = [mocks.nav[0]!]
  view.rerender(
    <NextIntlClientProvider locale="en" messages={en}>
      <MenuEditor slug="primary" />
    </NextIntlClientProvider>
  )
  fireEvent.click(screen.getByRole("button", { name: "Save menu" }))
  expect(mocks.save).not.toHaveBeenCalled()
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save menu" })).toBeEnabled()
  )
  expect(screen.getByDisplayValue("Keep me")).toBeTruthy()
  mocks.nav = original
  view.rerender(
    <NextIntlClientProvider locale="en" messages={en}>
      <MenuEditor slug="primary" />
    </NextIntlClientProvider>
  )
  fireEvent.click(screen.getByRole("button", { name: "Save menu" }))
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
  expect(mocks.save.mock.calls[0]![0].nav[0].label.fr).toBe("Keep me")
})

for (const region of ["main", "footer"] as const) {
  test.each(["typed-cleared", "untouched"] as const)(
    `typed_then_cleared_en_alt_is_decorative: ${region} %s`,
    async (mode) => {
      mocks.siteConfig = { enabledLocales: ["fr", "en"], defaultLocale: "fr" }
      const block = {
        id: "feature",
        kind: "featured" as const,
        heading: { fr: "Titre", en: "Heading" },
        image: {
          url: "https://example.com/feature.jpg",
          alt: { fr: "Image FR" },
        },
        target: {
          type: "external" as const,
          url: "https://example.com/feature",
        },
      }
      mocks.nav = [
        {
          id: "features",
          label: { fr: "Images", en: "Images EN" },
          panel: {
            columns: 1,
            blocks: region === "main" ? [block] : [],
            ...(region === "footer" ? { footer: { blocks: [block] } } : {}),
          },
        },
      ]
      renderEditor()
      fireEvent.click(screen.getByRole("tab", { name: "EN — Edit English" }))
      fireEvent.click(screen.getByRole("button", { name: "Expand item" }))
      if (mode === "typed-cleared") {
        fireEvent.change(screen.getByLabelText("Image alt text"), {
          target: { value: "Typed EN" },
        })
        fireEvent.change(screen.getByLabelText("Image alt text"), {
          target: { value: "" },
        })
      }
      // A later field spread must retain authored-alt intent in either region.
      fireEvent.change(screen.getByDisplayValue("Heading"), {
        target: { value: "Edited heading" },
      })
      fireEvent.click(screen.getByRole("button", { name: "Save menu" }))
      await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1))
      const saved: NavItem[] = mocks.save.mock.calls[0]![0].nav
      const savedBlock =
        region === "main"
          ? legacyPanel(saved[0]!.panel!).blocks[0]!
          : saved[0]!.panel!.footer!.blocks[0]!
      if (savedBlock.kind !== "featured") throw new Error("Expected featured")
      expect(savedBlock.image).toBeDefined()
      if (!savedBlock.image) throw new Error("Expected the saved featured image")
      expect(savedBlock.image.alt.fr).toBe("Image FR")
      expect(Object.hasOwn(savedBlock.image.alt, "en")).toBe(
        mode === "typed-cleared"
      )
      if (mode === "typed-cleared") expect(savedBlock.image.alt.en).toBe("")
      const publicNav = localizeCanonicalNav(saved, "en")
      const blocks =
        region === "main"
          ? legacyPanel(publicNav[0]!.panel!).blocks
          : publicNav[0]!.panel!.footer!.blocks
      expect(blocks).toHaveLength(mode === "typed-cleared" ? 1 : 0)
    }
  )
}

test.each(["success", "failure"] as const)(
  "locale_switch_disabled_while_saving: %s, structural FR save then EN edit",
  async (outcome) => {
    mocks.siteConfig = { enabledLocales: ["fr", "en"], defaultLocale: "fr" }
    mocks.nav = [{ id: "first", label: { fr: "Premier", en: "First" } }]
    let resolve!: () => void
    let reject!: (error: Error) => void
    const pending = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    mocks.save.mockImplementation(async (payload) => {
      mocks.nav = payload.nav
      return "menu-id"
    })
    mocks.save.mockImplementationOnce(async (payload) => {
      await pending
      mocks.nav = payload.nav
      return "menu-id"
    })
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: "Add navigation item" }))
    fireEvent.change(
      screen.getAllByRole("textbox", { name: "Navigation item label" })[1]!,
      {
        target: { value: "Ajout FR" },
      }
    )
    fireEvent.click(screen.getByRole("button", { name: "Save menu" }))
    for (const tab of screen.getAllByRole("tab")) expect(tab).toBeDisabled()
    const copy = screen.getByRole("button", { name: "Copy from…" })
    expect(copy).toBeDisabled()
    fireEvent.click(screen.getByRole("tab", { name: "EN — Edit English" }))
    expect(
      screen.getByRole("tab", { name: "FR — Edit Français" })
    ).toHaveAttribute("aria-selected", "true")
    await act(async () => {
      if (outcome === "success") resolve()
      else reject(new Error("save refused"))
      await pending.catch(() => {})
    })
    for (const tab of screen.getAllByRole("tab")) expect(tab).toBeEnabled()
    expect(copy).toBeEnabled()
    if (outcome === "failure") {
      fireEvent.click(screen.getByRole("button", { name: "Save menu" }))
      await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2))
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Save menu" })).toBeDisabled()
      )
    }
    fireEvent.click(screen.getByRole("tab", { name: "EN — Edit English" }))
    fireEvent.change(
      screen.getAllByRole("textbox", { name: "Navigation item label" })[1]!,
      {
        target: { value: "Added EN" },
      }
    )
    fireEvent.click(screen.getByRole("button", { name: "Save menu" }))
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledTimes(outcome === "success" ? 2 : 3)
    )
    const payload = mocks.save.mock.calls.at(-1)![0]
    expect(payload.locale).toBe("en")
    expect(payload.nav[1].label).toEqual({ fr: "Ajout FR", en: "Added EN" })
  }
)

test("dirty state clears after reverting and uses the menu name for heading and document title", () => {
  renderEditor()
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Main navigation"
  )
  expect(document.title).toBe("Main navigation")
  fireEvent.change(screen.getByDisplayValue("First"), {
    target: { value: "Changed" },
  })
  expect(screen.getByRole("button", { name: "Save menu" })).toBeEnabled()
  fireEvent.change(screen.getByDisplayValue("Changed"), {
    target: { value: "First" },
  })
  expect(screen.getByRole("button", { name: "Save menu" })).toBeDisabled()
})

test("leave and locale confirms cancel without changing the draft; confirmed leave navigates", async () => {
  renderEditor()
  fireEvent.change(screen.getByDisplayValue("First"), {
    target: { value: "Draft" },
  })
  mocks.confirm.mockResolvedValue(false)
  fireEvent.click(screen.getByRole("link", { name: "Menus" }))
  await waitFor(() =>
    expect(mocks.confirm).toHaveBeenCalledWith({
      title: en.menus.editor.leaveConfirm,
    })
  )
  expect(mocks.navigate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("tab", { name: "FR — Edit Français" }))
  await waitFor(() =>
    expect(mocks.confirm).toHaveBeenCalledWith({
      title: en.menus.editor.discardConfirm,
    })
  )
  expect(screen.getByDisplayValue("Draft")).toBeTruthy()
  mocks.confirm.mockResolvedValue(true)
  fireEvent.click(screen.getByRole("link", { name: "Menus" }))
  await waitFor(() =>
    expect(mocks.navigate).toHaveBeenCalledWith("/admin/menus")
  )
})

test("copy overwrite confirm cancels without changing any localized text", async () => {
  renderEditor()
  fireEvent.click(screen.getByRole("tab", { name: "FR — Edit Français" }))
  mocks.confirm.mockResolvedValue(false)
  fireEvent.keyDown(screen.getByRole("button", { name: "Copy from…" }), {
    key: "ArrowDown",
  })
  fireEvent.click(screen.getByRole("menuitem", { name: "Copy from EN" }))
  await waitFor(() =>
    expect(mocks.confirm).toHaveBeenCalledWith({
      title: "Replace existing FR text with EN text?",
    })
  )
  expect(screen.getByDisplayValue("Premier")).toBeTruthy()
  expect(
    screen.getAllByRole("textbox", { name: "Navigation item label" })[1]
  ).toHaveValue("")
})

test("deleting an item confirms and cancel keeps it", async () => {
  renderEditor()
  mocks.confirm.mockResolvedValue(false)
  fireEvent.click(screen.getAllByRole("button", { name: "Delete item" })[0]!)
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalled())
  expect(screen.getByDisplayValue("First")).toBeTruthy()
  mocks.confirm.mockResolvedValue(true)
  fireEvent.click(screen.getAllByRole("button", { name: "Delete item" })[0]!)
  await waitFor(() => expect(screen.queryByDisplayValue("First")).toBeNull())
})

for (const region of ["main", "footer"] as const) {
  for (const kind of ["linkGroup", "featured", "dynamicList"] as const) {
    test(`Save aggregates collapsed ${region} ${kind} errors without touching unrelated rows`, async () => {
      const badTarget = { type: "external" as const, url: "/invalid" }
      const block =
        kind === "linkGroup"
          ? {
              id: "bad-block",
              kind,
              links: [
                {
                  id: "bad-link",
                  label: { en: "Bad link" },
                  target: badTarget,
                },
              ],
            }
          : kind === "dynamicList"
            ? {
                id: "bad-block",
                kind,
                source: { pageType: "post" as const, limit: 3 },
                seeAll: { label: { en: "All" }, target: badTarget },
              }
            : {
                id: "bad-block",
                kind,
                heading: { en: "Feature" },
                image: { alt: { en: "" } },
                target: badTarget,
              }
      mocks.nav = [
        {
          id: "bad",
          label: { en: "Bad" },
          panel: {
            columns: 1,
            blocks: region === "main" ? [block] : [],
            footer: region === "footer" ? { blocks: [block] } : undefined,
          },
        },
        { id: "ok", label: { en: "Okay" } },
      ]
      renderEditor()
      expect(screen.queryAllByRole("alert")).toHaveLength(0)
      fireEvent.change(screen.getByDisplayValue("Bad"), {
        target: { value: "Changed" },
      })
      fireEvent.click(screen.getByRole("button", { name: "Save menu" }))
      await waitFor(() =>
        expect(screen.getAllByRole("alert").length).toBeGreaterThan(0)
      )
      expect(mocks.save).not.toHaveBeenCalled()
      expect(
        screen.getAllByRole("button", { name: "Collapse item" })
      ).toHaveLength(1)
      expect(
        screen.getAllByRole("button", { name: "Expand item" })
      ).toHaveLength(1)
      expect(document.activeElement).toHaveAttribute("aria-invalid", "true")
      expect(toast.error).toHaveBeenCalledWith(
        en.menus.editor.invalidFields,
        expect.objectContaining({ icon: expect.anything() })
      )
      if (kind === "featured")
        expect(screen.getByText("Choose an image.")).toBeTruthy()
    })
  }
}

test("Page intent clears a previous URL and refuses save before a selection", async () => {
  mocks.nav = [
    {
      id: "item",
      label: { en: "Item" },
      target: { type: "external", url: "https://example.com" },
    },
  ]
  renderEditor()
  fireEvent.click(screen.getByRole("button", { name: "Expand item" }))
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Page" }))
  expect(screen.queryByRole("alert")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Save menu" }))
  await waitFor(() =>
    expect(screen.getByText(en.menus.link.pageRequired)).toBeTruthy()
  )
  expect(mocks.save).not.toHaveBeenCalled()
  expect(screen.getByRole("button", { name: "Select page (EN)" })).toHaveFocus()
})

test("leaving Panneau confirms and cancellation retains its blocks", async () => {
  mocks.nav = [
    {
      id: "item",
      label: { en: "Item" },
      panel: {
        columns: 1,
        blocks: [
          {
            id: "list",
            kind: "dynamicList",
            source: { pageType: "post", limit: 3 },
          },
        ],
      },
    },
  ]
  renderEditor()
  fireEvent.click(screen.getByRole("button", { name: "Expand item" }))
  expect(
    screen.getByRole("tab", { name: "Panel", selected: true })
  ).toBeTruthy()
  mocks.confirm.mockResolvedValue(false)
  fireEvent.mouseDown(screen.getAllByRole("tab", { name: "No link" })[0]!)
  await waitFor(() =>
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Delete the panel and its blocks to choose “No link”?",
      })
    )
  )
  expect(
    screen.getByRole("tab", { name: "Panel", selected: true })
  ).toBeTruthy()
  mocks.confirm.mockResolvedValue(true)
  fireEvent.mouseDown(screen.getAllByRole("tab", { name: "No link" })[0]!)
  await waitFor(() => expect(screen.queryByText("Panel columns")).toBeNull())
})

test("empty secondary-locale icons distinguish every field type and authored empty alt", async () => {
  mocks.siteConfig = { defaultLocale: "fr", enabledLocales: ["fr", "en"] }
  mocks.nav = [
    {
      id: "item",
      label: { fr: "Élément" },
      panel: {
        columns: 1,
        blocks: [
          {
            id: "feature",
            kind: "featured",
            heading: { fr: "Vedette" },
            image: {
              url: "https://example.com/image.jpg",
              alt: { fr: "Image" },
            },
            target: { type: "external", url: "https://example.com" },
          },
          {
            id: "group",
            kind: "linkGroup",
            heading: { fr: "Groupe" },
            links: [
              {
                id: "link",
                label: { fr: "Lien" },
                target: { type: "external", url: "https://example.com" },
              },
            ],
          },
          {
            id: "list",
            kind: "dynamicList",
            heading: { fr: "Liste" },
            source: { pageType: "post", limit: 3 },
            seeAll: {
              label: { fr: "Tout voir" },
              target: { type: "external", url: "https://example.com" },
            },
          },
        ],
      },
    },
  ]
  renderEditor()
  fireEvent.click(screen.getByRole("tab", { name: "EN — Edit English" }))
  expect(
    screen.getByLabelText("Empty: this item does not appear in EN.")
  ).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Expand item" }))
  expect(
    screen.getByLabelText("Empty: this link does not appear in EN.")
  ).toBeTruthy()
  expect(
    screen.getByLabelText("Empty: the See all link does not appear in EN.")
  ).toBeTruthy()
  expect(screen.getAllByLabelText("Empty: no heading in EN.")).toHaveLength(2)
  expect(
    screen.getAllByLabelText("Empty: this block does not appear in EN.")
  ).toHaveLength(2)
  fireEvent.change(screen.getByLabelText("Image alt text"), {
    target: { value: "Typed" },
  })
  fireEvent.change(screen.getByLabelText("Image alt text"), {
    target: { value: "" },
  })
  expect(
    screen.getAllByLabelText("Empty: this block does not appear in EN.")
  ).toHaveLength(1)
  expect(screen.queryByRole("tab", { name: "Page" })).toBeNull()
})

test("link deletion confirms and cancellation keeps the complete group", async () => {
  mocks.nav = [
    {
      id: "item",
      label: { en: "Item" },
      panel: {
        columns: 1,
        blocks: [
          {
            id: "group",
            kind: "linkGroup",
            links: [
              {
                id: "link",
                label: { en: "Keep link" },
                target: { type: "external", url: "https://example.com" },
              },
            ],
          },
        ],
      },
    },
  ]
  renderEditor()
  fireEvent.click(screen.getByRole("button", { name: "Expand item" }))
  mocks.confirm.mockResolvedValue(false)
  const deletes = screen.getAllByRole("button", { name: "Delete" })
  fireEvent.click(deletes[1]!)
  await waitFor(() =>
    expect(mocks.confirm).toHaveBeenCalledWith({
      title: "Delete the link?",
      destructive: true,
    })
  )
  expect(screen.getByDisplayValue("Keep link")).toBeTruthy()
})

test("disabled item dims the entire editable card and retains its badge", () => {
  mocks.nav = [{ id: "item", label: { en: "Disabled" }, isDisabled: true }]
  renderEditor()
  fireEvent.click(screen.getByRole("button", { name: "Expand item" }))
  const card = screen.getByDisplayValue("Disabled").closest(".bg-card")!
  expect(card).toHaveClass("opacity-50")
  expect(card).toContainElement(screen.getByRole("tab", { name: "No link" }))
  expect(
    screen.getByText("Disabled", { selector: '[data-slot="badge"]' })
  ).toBeTruthy()
  expect(screen.getByDisplayValue("Disabled")).toBeEnabled()
})

test("Menus shows only primary/footer and configures by item count, not stored row presence", () => {
  mocks.useQuery.mockImplementation((reference, args) => {
    const name = getFunctionName(reference)
    if (name === "cms/owner:getOwnerSession") return mocks.owner
    if (name === "cms/menus:getCanonical")
      return { slug: args.slug, nav: args.slug === "primary" ? mocks.nav : [] }
    throw new Error(`Unexpected query ${name}`)
  })
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MenusPage />
    </NextIntlClientProvider>
  )
  expect(screen.getAllByRole("link")).toHaveLength(2)
  expect(
    screen.getByRole("link", { name: /Main navigation/ })
  ).toHaveTextContent("Configured")
  expect(
    screen.getByRole("link", { name: /Footer navigation/ })
  ).toHaveTextContent("Not configured")
  expect(screen.queryByText("Mobile navigation")).toBeNull()
  expect(screen.queryByRole("button", { name: /create menu/i })).toBeNull()
})

function rerenderEditor(view: ReturnType<typeof renderEditor>) {
  view.rerender(
    <NextIntlClientProvider locale="en" messages={en}>
      <MenuEditor slug="primary" />
    </NextIntlClientProvider>
  )
}

test.each(["menu-first", "settings-first"])("FR site load order: %s", (order) => {
  mocks.nav = [{ id: "french", label: { fr: "Accueil" } }]
  if (order === "menu-first") mocks.siteConfig = undefined
  else {
    mocks.siteConfig = { enabledLocales: ["fr"], defaultLocale: "fr" }
    mocks.menuLoaded = false
  }
  const view = renderEditor()
  expect(screen.getByText("Loading menu…")).toBeTruthy()
  expect(screen.queryByRole("button", { name: "Save menu" })).toBeNull()
  mocks.siteConfig = { enabledLocales: ["fr"], defaultLocale: "fr" }
  mocks.menuLoaded = true
  rerenderEditor(view)
  expect(screen.getByDisplayValue("Accueil")).toBeTruthy()
})

test("dirty draft pins its French locale and revision across reactive default and menu changes", async () => {
  mocks.siteConfig = { enabledLocales: ["fr", "en"], defaultLocale: "fr" }
  mocks.nav = [{ id: "item", label: { fr: "Original FR", en: "Original EN" } }]
  const view = renderEditor()
  fireEvent.change(screen.getByPlaceholderText("Navigation item label"), { target: { value: "Brouillon FR" } })
  mocks.siteConfig = { enabledLocales: ["fr", "en"], defaultLocale: "en" }
  mocks.updatedAt = 2
  mocks.nav = [{ id: "item", label: { fr: "Autre FR", en: "Other EN" } }]
  rerenderEditor(view)
  expect(screen.getByDisplayValue("Brouillon FR")).toBeTruthy()
  mocks.save.mockRejectedValueOnce(new Error("Menu changed since editing started"))
  fireEvent.click(screen.getByRole("button", { name: "Save menu" }))
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({
    slug: "primary", locale: "fr", expectedUpdatedAt: 1,
    nav: [{ id: "item", label: { fr: "Brouillon FR", en: "Other EN" } }],
  }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Failed to save menu"))
  expect(screen.getByDisplayValue("Brouillon FR")).toBeTruthy()
  mocks.confirm.mockResolvedValueOnce(false)
  fireEvent.click(screen.getByRole("tab", { name: "EN — Edit English" }))
  await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith({ title: "Discard unsaved changes and switch language?" }))
  expect(screen.getByDisplayValue("Brouillon FR")).toBeTruthy()
})

test("a missing menu draft always sends null even if a row arrives while editing", async () => {
  mocks.updatedAt = null
  mocks.nav = []
  const view = renderEditor()
  fireEvent.click(screen.getByRole("button", { name: "Add navigation item" }))
  mocks.updatedAt = 99
  rerenderEditor(view)
  fireEvent.click(screen.getByRole("button", { name: "Save menu" }))
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ expectedUpdatedAt: null, locale: "en" })))
})

test("a new item still needs a label in the tab where it was created", async () => {
  mocks.nav = []
  renderEditor()
  fireEvent.click(screen.getByRole("button", { name: "Add navigation item" }))
  fireEvent.change(screen.getByPlaceholderText("Navigation item label"), { target: { value: "  " } })
  fireEvent.click(screen.getByRole("button", { name: "Save menu" }))
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Correct the marked fields before saving.", expect.anything()))
  expect(mocks.save).not.toHaveBeenCalled()
})
