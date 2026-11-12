export function assertAuthoritativeSetupComplete(
  currentUrl: string,
  verifier: string
) {
  const pathname = new URL(currentUrl).pathname
  if (pathname === "/setup" || pathname.startsWith("/setup/")) {
    throw new Error(
      `${verifier} requires authoritative completed setup; the server redirected to ${pathname}. Complete setup through the supported flow, or run the onboarding verifier against a fresh disposable backend first.`
    )
  }
}
