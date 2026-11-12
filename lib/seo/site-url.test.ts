import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveSiteUrl } from "./site-url";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveSiteUrl", () => {
  test("strips trailing slash from explicit siteUrl", () => {
    expect(resolveSiteUrl("https://example.com/")).toBe("https://example.com");
  });

  test("adds https:// scheme when missing", () => {
    expect(resolveSiteUrl("example.com")).toBe("https://example.com");
  });

  test("falls back to localhost when no env is set", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    vi.stubEnv("VERCEL_URL", "");
    expect(resolveSiteUrl("")).toBe("http://localhost:3000");
  });

  test("uses NEXT_PUBLIC_SITE_URL when siteUrl is empty", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://env.example.com");
    expect(resolveSiteUrl("")).toBe("https://env.example.com");
  });

  test("prefixes scheme onto bare VERCEL_URL host", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    vi.stubEnv("VERCEL_URL", "myapp.vercel.app");
    expect(resolveSiteUrl("")).toBe("https://myapp.vercel.app");
  });
});
