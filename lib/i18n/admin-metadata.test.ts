import { sliceProfileAny, sliceProfile } from "@/test-utils/slice-profile"
import { createTranslator } from "next-intl"
import { expect, test } from "vitest"
import fr from "@/messages/admin/fr.json"
import {
  adminFieldMetadata,
  adminSliceMetadata,
  adminSliceGroupLabel,
  adminEmailProvider,
} from "./admin-metadata"
import {
  INSTALLED_SLICE_TYPES,
  sliceDefs,
  text,
  type Primitive,
} from "@/convex/lib/slices"
import { authorContentType } from "@/convex/lib/contentTypes/author"
import { postContentType } from "@/convex/lib/contentTypes/post"
import { SLICE_METADATA } from "@/lib/slices/builder"
const t = createTranslator({
  locale: "fr",
  messages: fr,
  namespace: "metadata",
})
test.skipIf(INSTALLED_SLICE_TYPES.length === 0).each(INSTALLED_SLICE_TYPES)(
  "current bundled %s metadata translates without replacing technical identity", sliceProfileAny(INSTALLED_SLICE_TYPES),
  (type) => {
    const original = SLICE_METADATA[type as keyof typeof SLICE_METADATA]!
    const localized = adminSliceMetadata(type, t)!
    expect(localized.label).not.toBe(original.label)
    expect(localized.description).not.toBe(original.description)
    expect(localized.icon).toBe(original.icon)
    expect(localized.group).toBe(original.group)
    expect(original.label).not.toBe(localized.label)
  }
)
test("owner metadata and custom copy on a bundled identity stay intact", sliceProfile([]), () => {
  const meta = {
    ...SLICE_METADATA["hero-agency"]!,
    origin: "user" as const,
    label: "My hero",
    description: "Owner copy",
  }
  expect(adminSliceMetadata("hero-agency", t, meta)).toBe(meta)
  expect(
    adminSliceMetadata("hero-agency", t, { ...meta, origin: "system" })
  ).toEqual({ ...meta, origin: "system" })
  expect(adminSliceGroupLabel("heroes", "Heroes", t)).toBe("Bannières")
})
test("bundled field hints translate and owner primitives with identical keys remain intact", sliceProfile([]), () => {
  const def = authorContentType.sharedFields.name
  expect(adminFieldMetadata(def, "name", t)).toMatchObject({
    label: "Nom",
    def: { config: { placeholder: "Nom complet" } },
  })
  expect(def.config.placeholder).toBe("Full name")
  const custom = text({ placeholder: "Full name" })
  expect(adminFieldMetadata(custom, "name", t)).toEqual({
    label: "Name",
    def: custom,
  })
  expect(
    adminFieldMetadata(
      postContentType.sharedFields.promoteToFront,
      "promoteToFront",
      t
    ).label
  ).toBe("Mettre en avant")
  const fields = sliceDefs["hero-with-image"].primary.config.fields as Record<
    string,
    Primitive
  >
  expect(
    adminFieldMetadata(fields.eyebrowLinkLabel, "eyebrowLinkLabel", t)
  ).toMatchObject({
    label: "Libellé du lien de surtitre",
    def: { config: { placeholder: "Rejoignez notre équipe à distance" } },
  })
})
test("known provider copy translates while brands and owner provider metadata remain intact", () => {
  expect(
    adminEmailProvider(
      {
        id: "resend",
        label: "Resend",
        description: "Transactional email delivery through Resend.",
      },
      t
    )
  ).toEqual({
    id: "resend",
    label: "Resend",
    description: "Envoi d’e-mails transactionnels avec Resend.",
  })
  const owner = {
    id: "owner",
    label: "Custom provider",
    description: "Owner description",
  }
  expect(adminEmailProvider(owner, t)).toBe(owner)
  const customized = {
    id: "resend",
    label: "Resend",
    description: "Owner description",
  }
  expect(adminEmailProvider(customized, t)).toBe(customized)
})
test("author fallback marker distinguishes empty content from an owner title literally Untitled", () => {
  const card = (doc: object) =>
    authorContentType.referenceCard({ _id: "author", ...doc } as never, "fr")
  expect(card({})).toMatchObject({
    title: "Untitled",
    titleFallback: "untitled",
  })
  expect(card({ content: { fr: { title: "Untitled" } } })).not.toHaveProperty(
    "titleFallback"
  )
  expect(card({ name: "Untitled" })).not.toHaveProperty("titleFallback")
  expect(
    card({ content: { fr: { title: "Titre du propriétaire" } } })
  ).toMatchObject({ title: "Titre du propriétaire" })
})
test("development caption localization keeps synthetic host/deployment identities and production guard", async () => {
  const { describeDevelopmentInstance } =
    await import("@/components/development-instance-badge")
  const td = createTranslator({
    locale: "fr",
    messages: fr,
    namespace: "development",
  })
  const labels = { caption: td("caption"), unidentified: td("unidentified") }
  expect(
    describeDevelopmentInstance(
      {
        NODE_ENV: "development",
        BETTER_AUTH_URL: "http://example.test:3333",
        CONVEX_DEPLOYMENT: "dev:owner-instance",
      },
      labels
    )
  ).toBe("Développement local · example.test:3333 · owner-instance")
  expect(describeDevelopmentInstance({ NODE_ENV: "development" }, labels)).toBe(
    "Développement local · localhost:3000 · Instance Convex non identifiée"
  )
  expect(
    describeDevelopmentInstance({ NODE_ENV: "production" }, labels)
  ).toBeNull()
})

test.each(["contact-form", "site-search", "cta-band"])(
  "parked %s has no authoring metadata",
  (type) => expect(adminSliceMetadata(type, t)).toBeUndefined()
)
