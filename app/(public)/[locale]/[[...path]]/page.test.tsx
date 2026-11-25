import { blockProfile } from "@/test-utils/block-profile"
import { render, screen } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import type { ReactElement } from "react"
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  buildBlockRenderContext: vi.fn(),
  fetchAuthMutation: vi.fn(),
  fetchAuthQuery: vi.fn(),
  fetchQuery: vi.fn(),
  isPreview: false,
  realConsumers: false,
  pageJsonLd: vi.fn(() => null),
  notFound: vi.fn(() => {
    const error = new Error("Not Found") as Error & { digest: string }
    error.digest = "NEXT_HTTP_ERROR_FALLBACK;404"
    throw error
  }),
  redirect: vi.fn((path: string) => {
    throw new Error(`Unexpected redirect to ${path}`)
  }),
  renderer: vi.fn(() => null),
}))

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>()
  return { ...actual, cache: <T,>(fn: T) => fn }
})

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
}))

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: () => (mocks.isPreview ? { value: "preview-session" } : undefined),
  })),
  draftMode: vi.fn(async () => ({ isEnabled: mocks.isPreview })),
}))

vi.mock("convex/nextjs", () => ({ fetchQuery: mocks.fetchQuery }))
vi.mock("@/lib/auth/server", () => ({
  fetchAuthMutation: mocks.fetchAuthMutation,
  fetchAuthQuery: mocks.fetchAuthQuery,
}))

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => `Admin ${key}`,
  getFormatter: async () => ({}),
}))

// Exercise our real read wrapper; only the framework cache boundary is a seam.
vi.mock("next/cache", () => ({
  unstable_cache: (run: () => Promise<unknown>) => run,
}))

vi.mock("@/lib/cms/versioned-read", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/cms/versioned-read")>()
  return actual
})

vi.mock("@/lib/blocks/render-context", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/blocks/render-context")>()
  return {
    buildBlockRenderContext: (
      options: Parameters<typeof actual.buildBlockRenderContext>[0]
    ) =>
      mocks.realConsumers
        ? actual.buildBlockRenderContext(options)
        : mocks.buildBlockRenderContext(options),
  }
})

vi.mock("@/components/content-types", async () => {
  const { DefaultBlockBodyRenderer } =
    await import("@/components/blocks/_shared/default-block-body")
  return {
    getContentTypeRenderer: () => ({
      kind: "blockBody",
      Component: mocks.realConsumers
        ? DefaultBlockBodyRenderer
        : mocks.renderer,
    }),
  }
})

vi.mock("@/components/seo/json-ld", () => ({ PageJsonLd: mocks.pageJsonLd }))
vi.mock("@/convex/lib/pages/blockBodyContent", () => ({
  hasBlockBody: () => true,
}))
vi.mock("@/convex/lib/contentTypes/routing", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/convex/lib/contentTypes/routing")>()
  return {
    ...actual,
    isRoutableContentType: () => true,
    seoTypesForContentType: () => ({ ogType: "website" }),
  }
})
vi.mock("@/convex/lib/contentTypes/exposure", () => ({
  publicFieldsOf: () => ({}),
}))
vi.mock("@/convex/lib/contentTypes/post", async (importOriginal) => {
  // The registry checks every descriptor when it loads, so the stub keeps the
  // real descriptor and only empties the shared fields and, to keep the two in
  // step (the definition check's validator-parity rule), the stored validator.
  const actual =
    await importOriginal<typeof import("@/convex/lib/contentTypes/post")>()
  const { v } = await import("convex/values")
  return {
    postContentType: {
      ...actual.postContentType,
      sharedFields: {},
      sharedValidator: v.object({}),
    },
  }
})

import CmsPage, { generateMetadata } from "./page"
import AdminPreviewPage from "@/app/(core)/admin/(authenticated)/pages/[id]/preview/page"

const page = {
  _id: "page-1",
  _creationTime: 1,
  slug: "english-only",
  status: "published",
  pageType: "page",
  content: {
    en: { title: "Private English fallback", blocks: [] },
  } as Record<string, { title: string; blocks: never[] }>,
  createdAt: 1,
  updatedAt: 1,
}

/** Site description per language, as the pinned public read returns it. */
const siteDescriptions: Record<string, string> = {}

/** Locales whose published version is `noIndex` (not an SEO alternate). */
const noIndexLocales = new Set<string>()

const config = {
  onboardingCompletedAt: 1,
  defaultLocale: "en",
  enabledLocales: ["en", "fr"],
  homePageId: null as string | null,
  siteUrl: "https://example.com",
  languageVersion: 1,
}

function queryResult(
  reference: unknown,
  args?: { locale?: string; languageVersion?: number }
) {
  const name = getFunctionName(reference as never)
  if (name === "cms/settings:getSiteConfig") return config
  if (name === "cms/pages:resolveLocalizedPathQuery") return page._id
  if (name === "cms/preview:resolvePreviewPath") {
    return { pageId: page._id, renderLocale: "en", isFallback: true }
  }
  if (name === "cms/preview:getPreviewPage") {
    return { page, requestedLocale: "fr", renderLocale: "en", isFallback: true }
  }
  if (name === "cms/pages:getPublicPageById") {
    const locale = args?.locale
    const content = locale ? page.content[locale] : undefined
    if (!locale || !content) return null
    return { ...page, content: { [locale]: content } }
  }
  if (name === "cms/pages:getPublicLocaleAlternates") {
    return config.enabledLocales
      .filter((locale) => page.content[locale])
      .map((locale) => ({
        locale,
        url:
          locale === config.defaultLocale
            ? "/english-only"
            : `/${locale}/english-only`,
        indexable: !noIndexLocales.has(locale),
      }))
  }
  if (name === "cms/settings:getBrandingUrls") {
    return { logo: null, favicon: null, og: null }
  }
  if (name === "cms/pages:getLocalizedBreadcrumb") return []
  if (name === "cms/settings:getPublicChrome") {
    return { siteDescription: siteDescriptions[args?.locale ?? ""] }
  }
  throw new Error(`Unexpected public query: ${name}`)
}

describe("public localized Page route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isPreview = false
    mocks.realConsumers = false
    config.enabledLocales = ["en", "fr"]
    config.defaultLocale = "en"
    config.languageVersion = 1
    config.homePageId = null
    for (const locale of Object.keys(page.content)) {
      if (locale !== "en") delete page.content[locale]
    }
    delete (page as { seo?: unknown }).seo
    noIndexLocales.clear()
    for (const key of Object.keys(siteDescriptions)) delete siteDescriptions[key]
    mocks.fetchQuery.mockImplementation(async (reference, args) =>
      queryResult(
        reference,
        args as { locale?: string; languageVersion?: number }
      )
    )
    mocks.fetchAuthQuery.mockImplementation(async (reference, args) =>
      queryResult(
        reference,
        args as { locale?: string; languageVersion?: number }
      )
    )
    mocks.fetchAuthMutation.mockImplementation(async (reference, args) =>
      queryResult(
        reference,
        args as { locale?: string; languageVersion?: number }
      )
    )
    mocks.buildBlockRenderContext.mockResolvedValue({
      locale: "en",
      defaultLocale: "en",
      pagePaths: {},
      relationCards: {},
    })
  })

  test.each([false, true])("marks Home by configured identity, preserving preview copy (%s)", async (preview) => {
    mocks.isPreview = preview
    config.homePageId = page._id
    render(await CmsPage({ params: Promise.resolve({ locale: "en", path: ["english-only"] }) }))
    expect(mocks.renderer).toHaveBeenCalledWith(expect.objectContaining({ isHomePage: !preview }), undefined)
  })

  test("an ordinary empty page is not marked Home", async () => {
    render(await CmsPage({ params: Promise.resolve({ locale: "en", path: ["english-only"] }) }))
    expect(mocks.renderer).toHaveBeenCalledWith(expect.objectContaining({ isHomePage: false }), undefined)
  })

  for (const query of [
    "cms/settings:getSiteConfig",
    "cms/pages:resolveLocalizedPathQuery",
    "cms/pages:getPublicPageById",
    "cms/pages:getPublicLocaleAlternates",
  ]) {
    for (const consumer of ["page", "metadata"] as const) {
      test(`${consumer} propagates ${query} failure without a not-found decision`, async () => {
        const failure = new Error("Convex temporarily unavailable")
        mocks.fetchQuery.mockImplementation(async (reference, args) => {
          if (getFunctionName(reference) === query) throw failure
          return queryResult(reference, args)
        })
        const props = {
          params: Promise.resolve({ locale: "en", path: ["english-only"] }),
        }
        await expect(
          consumer === "page" ? CmsPage(props) : generateMetadata(props)
        ).rejects.toBe(failure)
        expect(mocks.notFound).not.toHaveBeenCalled()
        expect(mocks.redirect).not.toHaveBeenCalled()
      })
    }
  }

  test.each([
    ["cms/pages:resolveLocalizedPathQuery", null],
    ["cms/pages:getPublicPageById", null],
    ["cms/pages:getPublicLocaleAlternates", []],
  ])(
    "confirmed absence from %s still reaches not-found",
    async (query, missing) => {
      mocks.fetchQuery.mockImplementation(async (reference, args) =>
        getFunctionName(reference) === query
          ? missing
          : queryResult(reference, args)
      )
      await expect(
        CmsPage({
          params: Promise.resolve({ locale: "en", path: ["english-only"] }),
        })
      ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" })
      expect(mocks.notFound).toHaveBeenCalledOnce()
    }
  )

  test("preview path failures retain the private not-found policy", async () => {
    mocks.isPreview = true
    mocks.fetchAuthMutation.mockRejectedValue(new Error("Preview unavailable"))
    await expect(
      CmsPage({
        params: Promise.resolve({ locale: "en", path: ["english-only"] }),
      })
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" })
  })

  test("preview keeps graceful canonical-alternate failure handling", async () => {
    mocks.isPreview = true
    mocks.fetchQuery.mockImplementation(async (reference, args) => {
      if (
        getFunctionName(reference) === "cms/pages:getPublicLocaleAlternates"
      ) {
        throw new Error("Alternates unavailable")
      }
      return queryResult(reference, args)
    })
    await expect(
      CmsPage({
        params: Promise.resolve({ locale: "en", path: ["english-only"] }),
      })
    ).resolves.toBeTruthy()
    expect(mocks.notFound).not.toHaveBeenCalled()
  })

  test("fails before canonical redirects or rendering when requested-locale content is absent", async () => {
    await expect(
      CmsPage({
        params: Promise.resolve({ locale: "fr", path: ["wrong-path"] }),
      })
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" })

    expect(mocks.redirect).not.toHaveBeenCalled()
    expect(mocks.buildBlockRenderContext).not.toHaveBeenCalled()
    expect(mocks.renderer).not.toHaveBeenCalled()
    expect(
      mocks.fetchQuery.mock.calls.map(([reference]) =>
        getFunctionName(reference)
      )
    ).not.toContain("cms/pages:getPublicLocaleAlternates")
  })

  test("emits no Page metadata when requested-locale content is absent", async () => {
    await expect(
      generateMetadata({
        params: Promise.resolve({ locale: "fr", path: ["english-only"] }),
      })
    ).resolves.toEqual({})

    const queryNames = mocks.fetchQuery.mock.calls.map(([reference]) =>
      getFunctionName(reference)
    )
    expect(queryNames).not.toContain("cms/pages:getPublicLocaleAlternates")
    expect(queryNames).not.toContain("cms/settings:getBrandingUrls")
  })

  test("renders requested-locale content when it is available", async () => {
    page.content.fr = { title: "Contenu français", blocks: [] }

    render(
      await CmsPage({
        params: Promise.resolve({
          locale: "fr",
          path: ["english-only"],
        }),
      })
    )

    expect(mocks.renderer).toHaveBeenCalledWith(
      expect.objectContaining({
        content: page.content.fr,
        locale: "fr",
        renderLocale: "fr",
      }),
      undefined
    )
    expect(screen.queryByText(/Content not available/)).toBeNull()
  })

  test("VISITOR-LIMITS refreshes every image on a 101-image page in reads of at most 50 ids", async () => {
    const english = page.content.en
    page.content.en = {
      title: "Many images",
      blocks: Array.from({ length: 101 }, (_, i) => ({
        id: `block-${i}`,
        image: {
          storageId: `img_${i}`,
          url: i === 100 ? "/stale-101" : `/old/${i}`,
        },
      })) as never[],
    }
    const storageReads: string[][] = []
    mocks.fetchQuery.mockImplementation(async (reference, args) => {
      if (getFunctionName(reference) === "cms/media:getStorageUrls") {
        const ids = (args as { storageIds: string[] }).storageIds
        if (ids.length > 50) throw new Error("TOO_MANY_IDS")
        storageReads.push(ids)
        return Object.fromEntries(ids.map((id) => [id, `/fresh/${id}`]))
      }
      return queryResult(
        reference,
        args as { locale?: string; languageVersion?: number }
      )
    })
    try {
      render(
        await CmsPage({
          params: Promise.resolve({ locale: "en", path: ["english-only"] }),
        })
      )
      expect(storageReads.map((ids) => ids.length)).toEqual([50, 50, 1])
      const rendered = (
        mocks.renderer.mock.calls.at(-1) as unknown as [
          { blocks: { image: { url: string } }[] },
        ]
      )[0].blocks
      expect(rendered).toHaveLength(101)
      expect(rendered[100].image.url).toBe("/fresh/img_100")
      expect(rendered.every(({ image }) => image.url.startsWith("/fresh/"))).toBe(
        true
      )
    } finally {
      page.content.en = english
    }
  })

  test("renders a rewritten default-locale path without redirecting to the visible URL", async () => {
    render(
      await CmsPage({
        params: Promise.resolve({
          locale: "en",
          path: ["en", "english-only"],
        }),
      })
    )

    expect(mocks.redirect).not.toHaveBeenCalled()
    expect(mocks.renderer).toHaveBeenCalled()
  })

  test("renders the sole enabled default locale normally", async () => {
    config.enabledLocales = ["en"]

    render(
      await CmsPage({
        params: Promise.resolve({
          locale: "en",
          path: ["english-only"],
        }),
      })
    )

    expect(mocks.renderer).toHaveBeenCalledWith(
      expect.objectContaining({
        content: page.content.en,
        locale: "en",
        renderLocale: "en",
      }),
      undefined
    )

    const metadata = await generateMetadata({
      params: Promise.resolve({
        locale: "en",
        path: ["english-only"],
      }),
    })
    expect(metadata.alternates).toEqual({
      canonical: "/english-only",
      languages: undefined,
    })
  })

  test("a disabled locale on a single-locale site reaches not-found before page lookup", async () => {
    config.enabledLocales = ["en"]

    await expect(
      CmsPage({
        params: Promise.resolve({
          locale: "fr",
          path: ["english-only"],
        }),
      })
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" })

    expect(
      mocks.fetchQuery.mock.calls.map(([reference]) =>
        getFunctionName(reference)
      )
    ).not.toContain("cms/pages:resolveLocalizedPathQuery")
  })

  test("canonical metadata retries the whole read with one fresh config version", async () => {
    let configReads = 0
    mocks.fetchQuery.mockImplementation(async (reference, args) => {
      const name = getFunctionName(reference as never)
      if (name === "cms/settings:getSiteConfig") {
        configReads += 1
        return {
          ...config,
          languageVersion: configReads === 1 ? 1 : 2,
        }
      }
      const readerArgs = args as {
        locale?: string
        languageVersion?: number
      }
      if (
        name === "cms/pages:resolveLocalizedPathQuery" &&
        readerArgs.languageVersion === 1
      ) {
        throw new Error("SITE_LANGUAGE_VERSION_CHANGED")
      }
      return queryResult(reference, readerArgs)
    })

    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "en", path: ["english-only"] }),
    })

    expect(metadata.alternates?.canonical).toBe("/english-only")
    expect(configReads).toBe(2)
    const publicReaderVersions = mocks.fetchQuery.mock.calls
      .map(([reference, args]) => ({
        name: getFunctionName(reference),
        version: (args as { languageVersion?: number }).languageVersion,
      }))
      .filter(({ name }) => name.startsWith("cms/pages:"))
      .map(({ version }) => version)
    expect(publicReaderVersions).toEqual([1, 2, 2, 2])
  })

  test("a second canonical version mismatch is not converted to empty metadata", async () => {
    let configReads = 0
    mocks.fetchQuery.mockImplementation(async (reference) => {
      const name = getFunctionName(reference as never)
      if (name === "cms/settings:getSiteConfig") {
        configReads += 1
        return { ...config, languageVersion: configReads }
      }
      if (name === "cms/pages:resolveLocalizedPathQuery") {
        throw new Error("SITE_LANGUAGE_VERSION_CHANGED")
      }
      return queryResult(reference)
    })

    await expect(
      generateMetadata({
        params: Promise.resolve({ locale: "en", path: ["english-only"] }),
      })
    ).rejects.toMatchObject({
      status: 503,
      retryAfter: 3,
      cacheControl: "no-store",
    })
    expect(configReads).toBe(2)
  })

  test("authenticated preview deliberately renders the default locale with a notice", async () => {
    mocks.isPreview = true

    render(
      await CmsPage({
        params: Promise.resolve({
          locale: "fr",
          path: ["english-only"],
        }),
      })
    )

    expect(screen.getByText(/Aperçu : contenu/)).toBeInTheDocument()
    expect(
      screen.getByText("publié", { selector: "strong" })
    ).toBeInTheDocument()
    expect(screen.queryByText(/Preview mode: showing/)).toBeNull()
    expect(
      screen.getByText(
        "Cette page n’est pas disponible en français. La version en anglais s’affiche."
      )
    ).toBeInTheDocument()
    expect(mocks.renderer).toHaveBeenCalledWith(
      expect.objectContaining({
        content: page.content.en,
        locale: "fr",
        renderLocale: "en",
      }),
      undefined
    )
  })
  // M05 P13a: canonical per locale; hreflang only for SEO alternates; the
  // x-default rule. Defaults other than English are covered too.
  describe("M05 P13a SEO metadata", () => {
    function publish(locales: readonly string[]) {
      for (const locale of locales) {
        page.content[locale] = { title: `Title ${locale}`, blocks: [] }
      }
    }

    async function metadataFor(locale: string) {
      return generateMetadata({
        params: Promise.resolve({ locale, path: ["english-only"] }),
      })
    }

    test("three locales: canonical per locale, hreflang for all, x-default to the default", async () => {
      config.enabledLocales = ["en", "fr", "de"]
      publish(["fr", "de"])

      for (const locale of ["en", "fr", "de"]) {
        const metadata = await metadataFor(locale)
        expect(metadata.alternates).toEqual({
          canonical:
            locale === "en" ? "/english-only" : `/${locale}/english-only`,
          languages: {
            en: "/english-only",
            fr: "/fr/english-only",
            de: "/de/english-only",
            "x-default": "/english-only",
          },
        })
      }
    })

    test("sixteen locales list every SEO alternate with no truncation", async () => {
      const locales = [
        "en",
        "fr",
        "es",
        "de",
        "it",
        "pt",
        "pt-br",
        "nl",
        "sv",
        "pl",
        "ru",
        "tr",
        "hi",
        "zh",
        "ja",
        "ko",
      ]
      config.enabledLocales = locales
      publish(locales)

      const metadata = await metadataFor("ko")
      expect(metadata.alternates?.canonical).toBe("/ko/english-only")
      expect(Object.keys(metadata.alternates?.languages ?? {})).toEqual([
        ...locales,
        "x-default",
      ])
    })

    test("a published noIndex locale is absent from hreflang but keeps its canonical", async () => {
      config.enabledLocales = ["en", "fr", "de"]
      publish(["fr", "de"])
      noIndexLocales.add("fr")

      expect((await metadataFor("de")).alternates?.languages).toEqual({
        en: "/english-only",
        de: "/de/english-only",
        "x-default": "/english-only",
      })
    })

    test("a noIndex rendered version emits no hreflang at all", async () => {
      config.enabledLocales = ["en", "fr"]
      publish(["fr"])
      ;(page as { seo?: unknown }).seo = { noIndex: true }

      const metadata = await metadataFor("fr")
      expect(metadata.alternates).toEqual({
        canonical: "/fr/english-only",
        languages: undefined,
      })
      expect(metadata.robots).toMatchObject({ index: false })
    })

    test("no x-default when the default language is not indexable", async () => {
      config.enabledLocales = ["en", "fr", "de"]
      publish(["fr", "de"])
      noIndexLocales.add("en")

      expect((await metadataFor("fr")).alternates?.languages).toEqual({
        fr: "/fr/english-only",
        de: "/de/english-only",
      })
    })

    test("no x-default when the default language has no published version", async () => {
      config.defaultLocale = "de"
      config.enabledLocales = ["de", "fr"]
      publish(["fr"])

      expect((await metadataFor("fr")).alternates?.languages).toEqual({
        fr: "/fr/english-only",
      })
    })

    test("a French default is unprefixed and is the x-default", async () => {
      config.defaultLocale = "fr"
      config.enabledLocales = ["fr", "en"]
      publish(["fr"])

      const metadata = await metadataFor("fr")
      expect(metadata.alternates).toEqual({
        canonical: "/english-only",
        languages: {
          fr: "/english-only",
          en: "/en/english-only",
          "x-default": "/english-only",
        },
      })
    })
  })

  describe("public fallback presentation through real context and body", () => {
    test("French preview of English fallback renders French fixed copy through the real context", async () => {
      mocks.isPreview = true
      mocks.realConsumers = true
      const originalEnglish = page.content.en
      page.content.en = { title: "Private English fallback", blocks: [] }
      try {
        render(
          await CmsPage({
            params: Promise.resolve({ locale: "fr", path: ["english-only"] }),
          })
        )
        expect(
          screen.getByRole("heading", { name: "Private English fallback" })
        ).toBeVisible()
        expect(
          screen.getByText(
            "Cette page n’est pas disponible en français. La version en anglais s’affiche."
          )
        ).toBeVisible()
        expect(screen.getByText("Aucun contenu pour le moment.")).toBeVisible()
      } finally {
        page.content.en = originalEnglish
      }
    })
    test("English preview of French default fallback renders English fixed copy through the real context", async () => {
      mocks.isPreview = true
      mocks.realConsumers = true
      config.defaultLocale = "fr"
      page.content.fr = { title: "Owner French fallback", blocks: [] }
      const originalEnglish = page.content.en
      delete page.content.en
      try {
        render(
          await CmsPage({
            params: Promise.resolve({ locale: "en", path: ["english-only"] }),
          })
        )
        expect(
          screen.getByRole("heading", { name: "Owner French fallback" })
        ).toBeVisible()
        expect(screen.getByText("No content yet.")).toBeVisible()
      } finally {
        page.content.en = originalEnglish
      }
    })
  })

  describe("admin staged fallback presentation through real context and body", () => {
    async function renderStagedFallback(
      locale: string,
      renderLocale: string,
      blocks: unknown[]
    ) {
      mocks.realConsumers = true
      config.defaultLocale = renderLocale
      const stagedPage = {
        ...page,
        content: {
          [renderLocale]: { title: "Owner staged title", blocks },
        },
      }
      mocks.fetchAuthQuery.mockResolvedValue({
        page: stagedPage,
        hasStaging: true,
      })
      const shell = await AdminPreviewPage({
        params: Promise.resolve({ id: page._id }),
        searchParams: Promise.resolve({ locale }),
      })
      // Resolve the actual async server shell before rendering its real body.
      const PreviewShell = shell.type as (
        props: typeof shell.props
      ) => Promise<ReactElement>
      render(await PreviewShell(shell.props))
      expect(
        mocks.fetchAuthQuery.mock.calls.map(([reference, args]) => [
          getFunctionName(reference),
          args,
        ])
      ).toEqual([["cms/pages:getStagedPreviewById", { id: page._id }]])
      expect(
        mocks.fetchQuery.mock.calls.map(([reference, args]) => [
          getFunctionName(reference),
          args,
        ])
      ).toEqual([["cms/settings:getSiteConfig", {}]])
      expect(mocks.buildBlockRenderContext).not.toHaveBeenCalled()
      expect(screen.getByText("Admin title")).toBeVisible()
      expect(
        screen.getByRole("heading", { name: "Owner staged title" })
      ).toBeInTheDocument()
    }

    for (const [locale, renderLocale, emptyCopy, faqLabel] of [
      [
        "fr",
        "en",
        "Aucun contenu pour le moment.",
        "Questions : Owner heading",
      ],
      ["en", "fr", "No content yet.", "Owner heading questions"],
    ]) {
      test(`${locale} over ${renderLocale} uses requested fixed empty copy`, async () => {
        await renderStagedFallback(locale, renderLocale, [])
        expect(screen.getByText(emptyCopy)).toBeVisible()
      })
      test(`${locale} over ${renderLocale} uses requested FAQ grammar and preserves owner values`, blockProfile(["faq-simple"]), async () => {
        const richText = (text: string) =>
          JSON.stringify({
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text }] }],
          })
        await renderStagedFallback(locale, renderLocale, [
          {
            id: "staged-faq",
            type: "faq-simple",
            enabled: true,
            primary: { heading: richText("Owner heading") },
            items: [
              { question: "Owner question", answer: richText("Owner answer") },
            ],
          },
        ])
        expect(
          screen.getByRole("heading", { name: "Owner heading" })
        ).toBeVisible()
        expect(
          screen.getByRole("button", { name: "Owner question" })
        ).toBeVisible()
        expect(screen.getByText("Owner answer")).toBeVisible()
        expect(screen.getByLabelText(faqLabel)).toBeVisible()
      })
    }
  })

  describe("site description fallback (M05 A5)", () => {
    type Content = { title: string; blocks: never[]; metaDescription?: string }

    function setContent(locale: string, content: Content) {
      page.content[locale] = content
    }

    async function metaDescription(locale: string) {
      const metadata = await generateMetadata({
        params: Promise.resolve({ locale, path: ["english-only"] }),
      })
      return metadata.description
    }

    async function jsonLdDescription(locale: string) {
      const tree = (await CmsPage({
        params: Promise.resolve({ locale, path: ["english-only"] }),
      })) as ReactElement<{ children: unknown[] }>
      const node = tree.props.children.find(
        (child) =>
          typeof child === "object" &&
          child !== null &&
          (child as ReactElement).type === mocks.pageJsonLd
      ) as ReactElement<{ description?: string }> | undefined
      expect(node).toBeDefined()
      return node!.props.description
    }

    beforeEach(() => {
      setContent("en", { title: "Private English fallback", blocks: [] })
      setContent("fr", { title: "Contenu français", blocks: [] })
    })

    test("the Page's own description wins over the site description", async () => {
      siteDescriptions.fr = "Site en français"
      setContent("fr", {
        title: "Contenu français",
        blocks: [],
        metaDescription: "Page en français",
      })
      expect(await metaDescription("fr")).toBe("Page en français")
      expect(await jsonLdDescription("fr")).toBe("Page en français")
    })

    test("the Page's SEO description wins in both places", async () => {
      siteDescriptions.fr = "Site en français"
      ;(page as { seo?: unknown }).seo = { metaDescription: "SEO en français" }
      expect(await metaDescription("fr")).toBe("SEO en français")
      expect(await jsonLdDescription("fr")).toBe("SEO en français")
    })

    test("without its own description a Page uses the site description in the visitor's language", async () => {
      siteDescriptions.en = "English site description"
      siteDescriptions.fr = "Description du site"
      expect(await metaDescription("fr")).toBe("Description du site")
      expect(await jsonLdDescription("fr")).toBe("Description du site")
      expect(await metaDescription("en")).toBe("English site description")
      expect(await jsonLdDescription("en")).toBe("English site description")
    })

    test("asks for the visitor's language, pinned to the config's language version", async () => {
      siteDescriptions.fr = "Description du site"
      config.languageVersion = 7
      await metaDescription("fr")
      expect(
        mocks.fetchQuery.mock.calls
          .filter(
            ([reference]) =>
              getFunctionName(reference) === "cms/settings:getPublicChrome"
          )
          .map(([, args]) => args)
      ).toEqual([{ locale: "fr", languageVersion: 7 }])
    })

    test("a language without a description emits none, never another language's", async () => {
      siteDescriptions.en = "English site description"
      expect(await metaDescription("fr")).toBeUndefined()
      expect(await jsonLdDescription("fr")).toBeUndefined()
    })
  })
})
