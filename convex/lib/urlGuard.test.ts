import { describe, expect, test, vi } from "vitest"
import {
  fetchWithSafeRedirects,
  guardOutboundUrl,
} from "./urlGuard"

function expectBlocked(rawUrl: string): void {
  expect(() => guardOutboundUrl(rawUrl)).toThrow()
}

describe("guardOutboundUrl", () => {
  test.each([
    "ftp://cdn.example.com/image.png",
    "file:///etc/passwd",
    "data:text/plain,hello",
    "https://user:password@cdn.example.com/image.png",
    "http://cdn.example.com:81/image.png",
    "https://cdn.example.com:444/image.png",
  ])("rejects forbidden URL form %s", (rawUrl) => {
    expectBlocked(rawUrl)
  })

  test.each([
    "http://cdn.example.com/image.png",
    "http://cdn.example.com:80/image.png",
    "https://cdn.example.com/image.png",
    "https://cdn.example.com:443/image.png",
  ])("accepts HTTP(S) only on its default port: %s", (rawUrl) => {
    expect(guardOutboundUrl(rawUrl).hostname).toBe("cdn.example.com")
  })

  test.each([
    "http://localhost/image.png",
    "http://api.localhost/image.png",
    "http://printer.local/image.png",
    "http://service.internal/image.png",
    "http://router.home/image.png",
    "http://nas.lan/image.png",
    "http://metadata/image.png",
  ])("rejects lexically local hostnames: %s", (rawUrl) => {
    expectBlocked(rawUrl)
  })

  test.each([
    ["decimal", "http://2130706433/image.png", "127.0.0.1"],
    ["hex", "http://0x7f000001/image.png", "127.0.0.1"],
    ["octal", "http://0177.0.0.1/image.png", "127.0.0.1"],
  ])(
    "pins WHATWG %s IPv4 normalization before rejecting it",
    (_label, rawUrl, normalizedHost) => {
      expect(new URL(rawUrl).hostname).toBe(normalizedHost)
      expectBlocked(rawUrl)
    }
  )

  const blockedIpv4Ranges: Array<[string, string, string]> = [
    ["unspecified", "0.0.0.0", "0.255.255.255"],
    ["private 10/8", "10.0.0.0", "10.255.255.255"],
    ["carrier-grade NAT", "100.64.0.0", "100.127.255.255"],
    ["loopback", "127.0.0.0", "127.255.255.255"],
    ["link-local", "169.254.0.0", "169.254.255.255"],
    ["private 172.16/12", "172.16.0.0", "172.31.255.255"],
    ["IETF protocol assignments", "192.0.0.0", "192.0.0.255"],
    ["documentation TEST-NET-1", "192.0.2.0", "192.0.2.255"],
    ["deprecated relay anycast", "192.88.99.0", "192.88.99.255"],
    ["private 192.168/16", "192.168.0.0", "192.168.255.255"],
    ["benchmarking", "198.18.0.0", "198.19.255.255"],
    ["documentation TEST-NET-2", "198.51.100.0", "198.51.100.255"],
    ["documentation TEST-NET-3", "203.0.113.0", "203.0.113.255"],
    ["multicast", "224.0.0.0", "239.255.255.255"],
    ["reserved", "240.0.0.0", "255.255.255.255"],
  ]

  test.each(blockedIpv4Ranges)(
    "rejects the lower and upper boundary of IPv4 %s",
    (_label, lower, upper) => {
      expectBlocked(`http://${lower}/image.png`)
      expectBlocked(`http://${upper}/image.png`)
    }
  )

  test.each([
    "192.0.0.9",
    "192.0.0.10",
    "192.31.196.0",
    "192.31.196.255",
    "192.52.193.0",
    "192.52.193.255",
    "192.175.48.0",
    "192.175.48.255",
    "8.8.8.8",
    "172.32.0.1",
  ])("accepts globally routable IPv4 literal %s", (host) => {
    expect(guardOutboundUrl(`https://${host}/image.png`).hostname).toBe(host)
  })

  const blockedIpv6Ranges: Array<[string, string, string]> = [
    ["IPv4-compatible", "::", "::ffff:ffff"],
    ["IPv4-mapped", "::ffff:0:0", "::ffff:ffff:ffff"],
    ["IPv4/IPv6 translation", "64:ff9b::", "64:ff9b::ffff:ffff"],
    [
      "local-use translation",
      "64:ff9b:1::",
      "64:ff9b:1:ffff:ffff:ffff:ffff:ffff",
    ],
    ["discard-only", "100::", "100::ffff:ffff:ffff:ffff"],
    [
      "dummy prefix",
      "100:0:0:1::",
      "100:0:0:1:ffff:ffff:ffff:ffff",
    ],
    ["Teredo", "2001::", "2001:0:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["deprecated ORCHID", "2001:10::", "2001:1f:ffff:ffff:ffff:ffff:ffff:ffff"],
    [
      "benchmarking",
      "2001:2::",
      "2001:2:ffff:ffff:ffff:ffff:ffff:ffff",
    ],
    ["documentation", "2001:db8::", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["6to4", "2002::", "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["documentation 3fff/20", "3fff::", "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["segment-routing SIDs", "5f00::", "5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["unique-local", "fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["link-local", "fe80::", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["deprecated site-local", "fec0::", "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["multicast", "ff00::", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ]

  test.each(blockedIpv6Ranges)(
    "rejects the lower and upper boundary of IPv6 %s",
    (_label, lower, upper) => {
      expectBlocked(`http://[${lower}]/image.png`)
      expectBlocked(`http://[${upper}]/image.png`)
    }
  )

  test.each([
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::127.0.0.1",
    "64:ff9b::7f00:1",
  ])("rejects IPv4-mapped or translated IPv6 literal %s", (host) => {
    expectBlocked(`http://[${host}]/image.png`)
  })

  test.each([
    "2001:1::1",
    "2001:1::2",
    "2001:1::3",
    "2001:3::",
    "2001:3:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:4:112::",
    "2001:4:112:ffff:ffff:ffff:ffff:ffff",
    "2001:20::",
    "2001:2f:ffff:ffff:ffff:ffff:ffff:ffff",
    "2001:30::",
    "2001:3f:ffff:ffff:ffff:ffff:ffff:ffff",
    "2606:4700:4700::1111",
  ])("accepts globally routable IPv6 literal %s", (host) => {
    expect(guardOutboundUrl(`https://[${host}]/image.png`).hostname).toContain(
      ":"
    )
  })
})

describe("fetchWithSafeRedirects", () => {
  test("revalidates each redirect and rejects a private destination", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private.png" },
        })
      )

    await expect(
      fetchWithSafeRedirects(
        "https://cdn.example.com/image.png",
        {},
        fetchImpl
      )
    ).rejects.toThrow("globally reachable")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: "manual" })
    )
  })

  test("follows at most three legitimate redirects on allowed ports", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: "https://a.cdn.example.com/one" },
        })
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "/two" },
        })
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: "https://b.cdn.example.com:443/three" },
        })
      )
      .mockResolvedValueOnce(
        new Response("image", {
          status: 200,
          headers: { "content-type": "image/png" },
        })
      )

    const result = await fetchWithSafeRedirects(
      "https://cdn.example.com/start",
      {},
      fetchImpl
    )
    expect(result.response.status).toBe(200)
    expect(result.url.href).toBe("https://b.cdn.example.com/three")
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  test("rejects a fourth redirect transition", async () => {
    const redirect = (location: string) =>
      new Response(null, { status: 302, headers: { location } })
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect("https://cdn.example.com/one"))
      .mockResolvedValueOnce(redirect("https://cdn.example.com/two"))
      .mockResolvedValueOnce(redirect("https://cdn.example.com/three"))
      .mockResolvedValueOnce(redirect("https://cdn.example.com/four"))

    await expect(
      fetchWithSafeRedirects(
        "https://cdn.example.com/start",
        {},
        fetchImpl
      )
    ).rejects.toThrow("at most 3 redirects")
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })
})
