/**
 * Shared policy for same-origin, rooted relative redirect targets. Sign-in
 * defaults to the admin; preview endpoints supply the public home fallback.
 *
 * Resolve the candidate against the current origin and compare origins, rather
 * than pattern-matching the string. Prefix checks look sufficient and are not:
 * `/\evil.com` starts with a single `/`, yet browsers resolve it to
 * `https://evil.com/` — as do `/%09/evil.com` and `/%0D/evil.com`, because the
 * URL parser strips tab and CR before parsing. Anything that resolves off-origin
 * is discarded, so the guard matches the navigation it is guarding.
 *
 * Lives outside `page.tsx` because Next.js rejects any non-page export from a
 * page module ("is not a valid Page export field") — a build-time check that
 * `tsc --noEmit` does not perform.
 */
export function safeNextPath(
  next: string | null,
  origin: string,
  fallback: "/admin" | "/" = "/admin"
): string {
  if (!next?.startsWith("/") || next.startsWith("//")) return fallback
  try {
    const url = new URL(next, origin)
    if (url.origin !== new URL(origin).origin) return fallback
    // Dot-segment normalization can expose a leading // in an on-origin URL's
    // pathname. Returning it as a relative target would reinterpret it as a host.
    if (url.pathname.startsWith("//")) return fallback
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return fallback
  }
}
