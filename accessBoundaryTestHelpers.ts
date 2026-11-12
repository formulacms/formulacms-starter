import { readFile } from "node:fs/promises"
import { expect } from "vitest"

/** F03.verify: the retired role/permission access vocabulary. */
export const RETIRED_ACCESS =
  /requirePermission|requireExactAdmin|resolveRoleAndPermissions|assertPagePermission|myPermissions/g

/** F03c: retired authorization tokens no boundary file may contain. */
export const RETIRED_AUTHORIZATION_TOKENS = [
  "lib/permissions",
  "hasPermission",
  "permittedPageTypes",
  "requireAnyPageTypePermission",
  "requireUser",
  "resolveRoleAndPermissions",
  'role === "admin"',
  'role !== "admin"',
  "auth.role",
] as const

/**
 * F03c boundary: the file reaches its access seam and carries none of the
 * retired `authHelpers` permission vocabulary. Shared by the shipped F03c
 * suite and the capability-owned boundary suites (FR2e, D-7).
 */
export async function expectF03cBoundary(file: string, seam: RegExp) {
  const source = await readFile(file, "utf8")
  expect(source, file).toMatch(seam)
  expect(source, file).not.toContain("lib/authHelpers")
  expect(source, file).not.toContain("requirePermission")
  expect(source, file).not.toContain("roles.myPermissions")
  for (const token of RETIRED_AUTHORIZATION_TOKENS) {
    expect(source, `${file} contains retired token ${token}`).not.toContain(token)
  }
}
