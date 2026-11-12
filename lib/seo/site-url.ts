// Absolute site origin for metadataBase: DB siteUrl → env → localhost. Always
// returns a scheme-qualified, valid origin so `new URL(...)` can't throw on a
// schemeless onboarding value (e.g. "example.com") and crash every page.
export function resolveSiteUrl(siteUrl: string): string {
  const raw =
    siteUrl ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`) ||
    "http://localhost:3000";
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return "http://localhost:3000";
  }
}
