# Security headers

The starter owns a portable application-level browser baseline in
`next.config.ts`. It is emitted on every route, including public, admin, auth,
API, simulator, and image responses:

- `Content-Security-Policy` enforces `base-uri 'self'`, `object-src 'none'`,
  `form-action 'self'`, and `frame-ancestors 'self'`.
- `X-Frame-Options: SAMEORIGIN` keeps same-origin Slice simulator and preview
  iframes usable while rejecting foreign framing.
- `X-Content-Type-Options: nosniff` prevents MIME sniffing.
- `Referrer-Policy: strict-origin-when-cross-origin` limits cross-origin
  referrer detail.
- `Permissions-Policy` disables camera, microphone, and geolocation.
- `X-Powered-By` is omitted.

Script and style sources remain in `Content-Security-Policy-Report-Only`.
Review those findings against the actual runtime before enforcing them. Next.js
16 requires dynamic rendering for nonce-based CSP; a static policy requires
`unsafe-inline` for generated scripts and styles. This starter deliberately
leaves that nonce-versus-static decision explicit rather than silently choosing
one.

TLS and HSTS are edge-owned deployment concerns. They are not proven by the
local HTTP baseline. Verify `Strict-Transport-Security` and deployed HTTPS
behavior only against a specifically authorized deployment target.

For a local production build, inspect the emitted headers with:

```bash
curl -sSI http://localhost:3000/
```
