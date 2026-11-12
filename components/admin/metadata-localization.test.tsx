import { sliceProfile } from "@/test-utils/slice-profile"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest"
import { NextIntlClientProvider } from "next-intl"
import { getFunctionName } from "convex/server"
import { MultiRelationPicker } from "./relation-picker"
import { EmailSettings } from "./email-settings"
import { ConfirmProvider } from "@/components/providers/confirm-provider"
import { ContentTypeFieldsPanel } from "./content-type-fields-panel"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import { PageLivePreviewCanvas as PageLivePreview } from "./page-live-preview-canvas"
import { ButtonsEditor } from "./fields/buttons-editor"
import { LinkPagePicker } from "./fields/link-page-picker"
// Match the real-preview DOM harness; jsdom does not implement Range geometry.
const rangeRects = {
  getClientRects: Object.getOwnPropertyDescriptor(
    Range.prototype,
    "getClientRects"
  ),
  getBoundingClientRect: Object.getOwnPropertyDescriptor(
    Range.prototype,
    "getBoundingClientRect"
  ),
}
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [new DOMRect()],
  })
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  })
})
afterAll(() => {
  for (const [key, descriptor] of Object.entries(rangeRects)) {
    if (descriptor) Object.defineProperty(Range.prototype, key, descriptor)
    else Reflect.deleteProperty(Range.prototype, key)
  }
})
const state = vi.hoisted(() => ({ mode: "default" }))
vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
  useQuery: (ref: unknown) => {
    const name = getFunctionName(ref as never)
    if (state.mode === "relations")
      return [
        {
          id: "a",
          type: "author",
          title: "Untitled",
          titleFallback: "untitled",
        },
        { id: "b", type: "author", title: "Untitled" },
      ]
    if (state.mode === "email") {
      if (name.endsWith("getOwnerSession")) return { ownerId: "owner" }
      return {
        catalogue: [
          {
            id: "resend",
            label: "Resend",
            description: "Transactional email delivery through Resend.",
            registered: true,
            bundled: true,
            documentationUrl: "https://resend.com/docs",
          },
          {
            id: "custom",
            label: "Custom provider",
            description:
              "Register a reviewed provider implementation in this application build.",
            registered: false,
            bundled: false,
            documentationUrl: "https://example.com",
          },
          {
            id: "owner",
            label: "Owner provider",
            description: "Owner words",
            registered: true,
            bundled: false,
            documentationUrl: "https://example.com",
          },
        ],
        configuredProviderId: "resend",
        activeProviderId: null,
        readiness: "fallback",
        configurationVersion: 0,
      }
    }
    return undefined
  },
}))
beforeEach(() => {
  state.mode = "default"
})
vi.mock("./fields/media-picker", () => ({ MediaPicker: () => null }))
vi.mock("./fields/image-field-editor", () => ({ ImageFieldEditor: () => null }))
afterEach(cleanup)
function french(children: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="fr" messages={fr}>
      {children}
    </NextIntlClientProvider>
  )
}
test("French button options keep their serialized values and owner label", () => {
  french(
    <ButtonsEditor
      locale="en"
      value={[
        {
          id: "a",
          label: "Owner label",
          link: { type: "none" },
          variant: "primary",
          enabled: true,
          withIcon: false,
        },
      ]}
      onChange={() => {}}
    />
  )
  expect(screen.getByRole("option", { name: "Principal" })).toHaveValue(
    "primary"
  )
  expect(screen.getByRole("option", { name: "Aucun" })).toHaveValue("none")
  expect(screen.getByDisplayValue("Owner label")).toBeInTheDocument()
})
test("generic internal-link picker has a French default without menu overrides", () => {
  french(<LinkPagePicker value={undefined} locale="en" onChange={() => {}} />)
  expect(
    screen.getByRole("button", { name: /Sélectionner une page/ })
  ).toBeInTheDocument()
})

test("new button editable text follows content locale independently of admin language", () => {
  const onChange = vi.fn()
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ButtonsEditor locale="fr" value={[]} onChange={onChange} />
    </NextIntlClientProvider>
  )
  fireEvent.click(screen.getByRole("button", { name: "Add button" }))
  expect(onChange.mock.calls[0][0][0].label).toBe("Bouton")
})
test("generic author shared and localized field consumers display French metadata", () => {
  french(
    <ContentTypeFieldsPanel
      contentType={{
        type: "author",
        singular: "Author",
        plural: "Authors",
        routable: true,
        dictionaryKey: "author",
      }}
      sharedValues={{ name: "Owner name" }}
      localizedValues={{ roleTitle: "Owner role" }}
      currentLocale="en"
      onSharedChange={() => {}}
      onLocalizedChange={() => {}}
    />
  )
  expect(screen.getByRole("textbox", { name: "Nom" })).toHaveValue("Owner name")
  expect(screen.getByPlaceholderText("Nom complet")).toBeInTheDocument()
  expect(screen.getByRole("textbox", { name: "Fonction" })).toHaveValue(
    "Owner role"
  )
})
test("reference picker translates marked fallbacks and retains owner literal Untitled", () => {
  state.mode = "relations"
  french(
    <MultiRelationPicker
      pageTypes={["author"]}
      value={[]}
      onChange={() => {}}
      locale="en"
    />
  )
  expect(screen.getByRole("option", { name: /Sans titre/ })).toBeInTheDocument()
  expect(screen.getByRole("option", { name: /Untitled/ })).toBeInTheDocument()
})
test("email settings translates bundled and custom catalogue copy at the consumer", () => {
  state.mode = "email"
  french(
    <ConfirmProvider>
      <EmailSettings />
    </ConfirmProvider>
  )
  expect(
    screen.getAllByText("Envoi d’e-mails transactionnels avec Resend.").length
  ).toBeGreaterThan(0)
  expect(screen.getByText("Fournisseur personnalisé")).toBeInTheDocument()
  expect(screen.getByText("Owner words")).toBeInTheDocument()
  expect(
    screen.queryByRole("button", { name: "Ajouter un fournisseur d’e-mail" })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByPlaceholderText("Rechercher un fournisseur")
  ).not.toBeInTheDocument()
})
test("dialog accessible Close default uses the admin language", () => {
  french(
    <Dialog open>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle>Owner title</DialogTitle>
      </DialogContent>
    </Dialog>
  )
  expect(screen.getByRole("button", { name: "Fermer" })).toBeInTheDocument()
})

test("inline preview accessible field labels use admin French while keeping owner content", sliceProfile([]), async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  french(
    <PageLivePreview
      title="Owner page"
      slices={[
        {
          id: "hero",
          type: "hero-agency",
          enabled: true,
          primary: {
            eyebrow: "Owner eyebrow",
            title: JSON.stringify({
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Owner title" }],
                },
              ],
            }),
            description: "Owner description",
          },
          items: [],
        },
      ]}
      locale="en"
      defaultLocale="en"
      selectedSliceId={null}
      onSelectSlice={() => {}}
      onSelectField={() => {}}
      onInlineEditCommit={() => {}}
      controlledInlineEnabled
    />
  )
  fireEvent.click(screen.getByText("Owner title"))
  expect(
    await screen.findByRole("textbox", { name: "Modifier directement Titre" })
  ).toHaveTextContent("Owner title")
  vi.unstubAllGlobals()
})
