export type PublicLocaleContentSelection<T> = {
  content: T
  renderLocale: string
  isFallback: boolean
}

/**
 * Select locale content for the public renderer.
 *
 * Ordinary public requests are locale-strict. Authenticated Draft Mode preview
 * deliberately retains the former default-locale fallback so editors can
 * inspect an incomplete locale in the surrounding public layout.
 */
export function selectPublicLocaleContent<T>(
  contentByLocale: Readonly<Partial<Record<string, T>>> | undefined,
  requestedLocale: string,
  defaultLocale: string,
  allowPreviewFallback: boolean
): PublicLocaleContentSelection<T> | null {
  const requestedContent = contentByLocale?.[requestedLocale]
  if (requestedContent !== undefined) {
    return {
      content: requestedContent,
      renderLocale: requestedLocale,
      isFallback: false,
    }
  }

  if (!allowPreviewFallback) return null

  const fallbackContent = contentByLocale?.[defaultLocale]
  if (fallbackContent === undefined) return null

  return {
    content: fallbackContent,
    renderLocale: defaultLocale,
    isFallback: true,
  }
}
