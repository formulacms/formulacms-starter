export type StarterAppLocaleContract = {
  defaultLocale: string
  locales: string[]
}

export function localeContractMismatch(
  expected: StarterAppLocaleContract,
  actual: StarterAppLocaleContract
): string | null {
  if (actual.defaultLocale !== expected.defaultLocale) {
    return `expected default locale ${expected.defaultLocale}, saw ${actual.defaultLocale}`
  }

  const expectedLocales = [...expected.locales].sort()
  const actualLocales = [...actual.locales].sort()
  if (JSON.stringify(actualLocales) !== JSON.stringify(expectedLocales)) {
    return `expected enabled locales ${expectedLocales.join(",")}, saw ${actualLocales.join(",")}`
  }
  return null
}

function parseLocales(value: string): string[] {
  const locales = value
    .split(",")
    .map((locale) => locale.trim())
    .filter(Boolean)

  if (locales.length === 0) {
    throw new Error("STARTER_APP_QA_LOCALES must name at least one locale.")
  }
  if (new Set(locales).size !== locales.length) {
    throw new Error("STARTER_APP_QA_LOCALES must not contain duplicates.")
  }
  return locales
}

export function expectedStarterAppLocaleContract(
  defaultLocaleValue: string | undefined,
  localesValue: string | undefined
): StarterAppLocaleContract | null {
  const defaultLocale = defaultLocaleValue?.trim()
  const rawLocales = localesValue?.trim()

  if (!defaultLocale && !rawLocales) return null
  if (!defaultLocale || !rawLocales) {
    throw new Error(
      "Set STARTER_APP_QA_DEFAULT_LOCALE and STARTER_APP_QA_LOCALES together."
    )
  }

  const locales = parseLocales(rawLocales)
  if (!locales.includes(defaultLocale)) {
    throw new Error(
      `STARTER_APP_QA_LOCALES must include default locale ${defaultLocale}.`
    )
  }

  return { defaultLocale, locales }
}

export function sameOriginPath(value: string, baseUrl: string): string {
  const expectedOrigin = new URL(baseUrl).origin
  const url = new URL(value, baseUrl)
  if (url.origin !== expectedOrigin) {
    throw new Error(`expected origin ${expectedOrigin}, saw ${url.origin}`)
  }
  const path = url.pathname.startsWith("/") ? url.pathname : `/${url.pathname}`
  return path === "/" ? "/" : path.replace(/\/+$/, "")
}

// How a published page declares its language versions. With one enabled
// language it publishes a canonical link only (F09 row 23); with more than one
// it adds hreflang alternates and x-default (M05). The public renderer gates
// alternates the same way, on more than one enabled locale.
export type StarterAppLanguageLinks = "canonical-only" | "hreflang"

export type StarterAppPublishedSnapshot = {
  htmlLang: string
  finalPath: string
  alternates: Record<string, string>
}

export type StarterAppInferredContract = {
  contract: StarterAppLocaleContract
  links: StarterAppLanguageLinks
  failures: string[]
}

function sortedLocales(defaultLocale: string, locales: string[]) {
  return [...new Set([defaultLocale, ...locales])].filter(Boolean)
}

export function expectedLanguageLinks(
  contract: StarterAppLocaleContract
): StarterAppLanguageLinks {
  return contract.locales.length > 1 ? "hreflang" : "canonical-only"
}

export function inferLocaleContract(
  root: Pick<StarterAppPublishedSnapshot, "htmlLang" | "alternates">
): StarterAppInferredContract {
  const failures: string[] = []
  const defaultLocale = root.htmlLang
  if (!defaultLocale) {
    failures.push(
      "/: cannot infer default locale because <html lang> is empty."
    )
  }

  const alternateLocales = Object.keys(root.alternates).filter(
    (locale) => locale !== "x-default"
  )
  // A single-language site names its language through <html lang> alone.
  if (alternateLocales.length === 0) {
    const locale = defaultLocale || "en"
    return {
      contract: { defaultLocale: locale, locales: [locale] },
      links: "canonical-only",
      failures,
    }
  }
  if (defaultLocale && !alternateLocales.includes(defaultLocale)) {
    failures.push(
      `/: hreflang alternates do not include default locale ${defaultLocale}.`
    )
  }

  const inferredDefault = defaultLocale || alternateLocales[0]
  return {
    contract: {
      defaultLocale: inferredDefault,
      locales: sortedLocales(inferredDefault, alternateLocales),
    },
    links: "hreflang",
    failures,
  }
}

export function languageLinkFailures(
  snapshot: Pick<StarterAppPublishedSnapshot, "finalPath" | "alternates">,
  label: string,
  expectedLocale: string | null,
  contract: StarterAppLocaleContract,
  links: StarterAppLanguageLinks
): string[] {
  if (links === "canonical-only") {
    const exposed = Object.keys(snapshot.alternates)
    return exposed.length === 0
      ? []
      : [
          `${label}: a single-language site publishes a canonical link only, but the page exposes hreflang alternates ${exposed.join(", ")}.`,
        ]
  }

  const failures: string[] = []
  for (const locale of contract.locales) {
    if (!snapshot.alternates[locale]) {
      failures.push(`${label}: missing hreflang alternate for ${locale}.`)
    }
  }
  const defaultAlternate = snapshot.alternates[contract.defaultLocale]
  const xDefault = snapshot.alternates["x-default"]
  if (!xDefault) {
    failures.push(`${label}: missing x-default hreflang alternate.`)
  } else if (defaultAlternate && xDefault !== defaultAlternate) {
    failures.push(
      `${label}: x-default ${xDefault} does not match default-locale URL ${defaultAlternate}.`
    )
  }
  if (
    expectedLocale &&
    snapshot.alternates[expectedLocale] &&
    snapshot.alternates[expectedLocale] !== snapshot.finalPath
  ) {
    failures.push(
      `${label}: hreflang ${expectedLocale} points to ${snapshot.alternates[expectedLocale]}, expected ${snapshot.finalPath}.`
    )
  }
  return failures
}
