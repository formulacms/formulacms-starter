import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { PHASE_PRODUCTION_BUILD } from "next/constants"
import createNextConfig from "../next.config"
import {
  ENFORCED_CONTENT_SECURITY_POLICY,
  getPortableSecurityHeaders,
  IMAGE_CONTENT_SECURITY_POLICY,
  PORTABLE_SECURITY_HEADER_VALUES,
  REPORT_ONLY_CONTENT_SECURITY_POLICY,
} from "../lib/security/headers"

const nextConfig = createNextConfig(PHASE_PRODUCTION_BUILD)

function asHeaderMap(headers: Array<{ key: string; value: string }>) {
  return Object.fromEntries(headers.map(({ key, value }) => [key, value]))
}

describe("portable security-header baseline", () => {
  test("keeps the enforced policy structural and nonce-free", () => {
    expect(ENFORCED_CONTENT_SECURITY_POLICY).toBe(
      "base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'self'"
    )
    expect(ENFORCED_CONTENT_SECURITY_POLICY).not.toMatch(
      /(?:script|style)-src/
    )
    expect(ENFORCED_CONTENT_SECURITY_POLICY).not.toContain("nonce-")
    expect(ENFORCED_CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline")
  })

  test("keeps script and style enforcement report-only", () => {
    expect(REPORT_ONLY_CONTENT_SECURITY_POLICY).toContain("script-src 'self'")
    expect(REPORT_ONLY_CONTENT_SECURITY_POLICY).toContain("style-src 'self'")
    expect(REPORT_ONLY_CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline")
    expect(REPORT_ONLY_CONTENT_SECURITY_POLICY).toContain("frame-src 'self'")
    expect(REPORT_ONLY_CONTENT_SECURITY_POLICY).toContain(
      "frame-ancestors 'self'"
    )
  })

  test("carries the structural floor into Next image responses", () => {
    expect(IMAGE_CONTENT_SECURITY_POLICY).toContain(
      ENFORCED_CONTENT_SECURITY_POLICY
    )
    expect(IMAGE_CONTENT_SECURITY_POLICY).toContain("script-src 'none'")
    expect(IMAGE_CONTENT_SECURITY_POLICY).toContain("sandbox")
    expect(nextConfig.images?.contentSecurityPolicy).toBe(
      IMAGE_CONTENT_SECURITY_POLICY
    )
  })

  test("defines every required portable response header", () => {
    expect(asHeaderMap(getPortableSecurityHeaders())).toEqual(
      PORTABLE_SECURITY_HEADER_VALUES
    )
    expect(PORTABLE_SECURITY_HEADER_VALUES["X-Frame-Options"]).toBe(
      "SAMEORIGIN"
    )
    expect(PORTABLE_SECURITY_HEADER_VALUES["X-Content-Type-Options"]).toBe(
      "nosniff"
    )
    expect(PORTABLE_SECURITY_HEADER_VALUES["Referrer-Policy"]).toBe(
      "strict-origin-when-cross-origin"
    )
    expect(PORTABLE_SECURITY_HEADER_VALUES["Permissions-Policy"]).toBe(
      "camera=(), microphone=(), geolocation=()"
    )
  })

  test("wires the baseline to every Next route and removes framework disclosure", async () => {
    expect(nextConfig.poweredByHeader).toBe(false)
    expect(nextConfig.headers).toBeTypeOf("function")

    const rules = await nextConfig.headers!()
    expect(rules).toHaveLength(1)
    expect(rules[0]?.source).toBe("/(.*)")
    expect(asHeaderMap(rules[0]?.headers ?? [])).toEqual(
      PORTABLE_SECURITY_HEADER_VALUES
    )

    const source = readFileSync("next.config.ts", "utf8")
    expect(source).toContain("poweredByHeader: false")
    expect(source).toContain("getPortableSecurityHeaders()")
  })
})
