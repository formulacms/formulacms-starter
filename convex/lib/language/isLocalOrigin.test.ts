import { describe, expect, test } from "vitest"
import { isLocalOrigin } from "./lifecycle"

describe("isLocalOrigin (M05 A2)", () => {
  test.each([
    "http://localhost:3000",
    "https://LOCALHOST",
    "http://app.localhost:3000",
    "http://127.0.0.1:3000",
    "http://127.8.8.8",
    "http://10.0.0.5",
    "http://172.16.0.1",
    "http://172.31.255.255",
    "http://192.168.1.20:3000",
    "http://169.254.10.10",
    "http://0.0.0.0:3000",
    "http://mac.local:3000",
    "http://[::1]:3000",
    "http://[fe80::1]",
    "http://[fd12:3456::1]",
  ])("%s is local", (url) => {
    expect(isLocalOrigin(url)).toBe(true)
  })

  test.each([
    "https://site.example.com",
    "https://example.com:8443",
    "http://172.15.0.1",
    "http://172.32.0.1",
    "http://192.169.1.1",
    "http://8.8.8.8",
    "https://localhost.example.com",
    "https://notlocal.example.com",
    "http://[2001:db8::1]",
    "not a url",
    "",
  ])("%s is not local", (url) => {
    expect(isLocalOrigin(url)).toBe(false)
  })
})
