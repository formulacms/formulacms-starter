export const ENFORCED_CONTENT_SECURITY_POLICY = [
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ")

// This policy is deliberately report-only. Next.js 16 requires dynamic
// rendering for nonce-based CSP, while a static policy needs unsafe-inline for
// the framework's generated scripts and styles. Keep the decision visible
// until the runtime has an explicit nonce-versus-static owner decision.
export const REPORT_ONLY_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data: https://storage.convex.dev https://*.convex.cloud https://*.convex.site http://localhost:* http://127.0.0.1:*",
  "font-src 'self' data:",
  "connect-src 'self' https://*.convex.cloud https://*.convex.site http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:* wss://*.convex.cloud",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ")

// Next's image optimizer replaces the route-level CSP on optimized image
// responses. Preserve its SVG sandbox while carrying the same structural
// floor, so media responses do not become a security-header bypass.
export const IMAGE_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'none'",
  "sandbox",
  ENFORCED_CONTENT_SECURITY_POLICY,
].join("; ")

export const PORTABLE_SECURITY_HEADER_VALUES = {
  "Content-Security-Policy": ENFORCED_CONTENT_SECURITY_POLICY,
  "Content-Security-Policy-Report-Only":
    REPORT_ONLY_CONTENT_SECURITY_POLICY,
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
} as const

export function getPortableSecurityHeaders(): Array<{
  key: string
  value: string
}> {
  return Object.entries(PORTABLE_SECURITY_HEADER_VALUES).map(
    ([key, value]) => ({ key, value })
  )
}
