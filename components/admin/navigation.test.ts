import { describe, expect, it } from "vitest"
import { MODULE_CATALOG } from "@/lib/modules/catalog"
import type { ModuleDescriptorV1 } from "@/lib/modules/types"
import {
  ADMIN_NAVIGATION,
  REDIRECTS_NAVIGATION,
  composeAdminNavigation,
} from "./navigation"

describe("ADMIN_NAVIGATION", () => {
  it("uses one Content entry for every content type", () => {
    const content = ADMIN_NAVIGATION.find((item) => item.name === "Content")

    expect(content).toMatchObject({
      href: "/admin/pages",
      labelKey: "content",
      requiresAnyPageTypeList: true,
    })
    expect(ADMIN_NAVIGATION.some((item) => "contentType" in item)).toBe(false)
  })

  it("does not expose Community membership or Team settings routes", () => {
    expect(
      ADMIN_NAVIGATION.some((item) =>
        /members|roles|invite|capacity|review|publishing/i.test(item.href)
      )
    ).toBe(false)
  })
})

// M01c-P7 (recovery design B4, RG1): the installed navigation is evaluated at
// module load, so an invalid registration fails this suite before release.
describe("installed admin navigation composition (M01c)", () => {
  it("registers Redirects as static data owned by an optional module that declares admin.navigation", () => {
    expect(
      ADMIN_NAVIGATION.find((item) => item.href === "/admin/redirects")
    ).toMatchObject({ name: "Redirects", moduleId: "redirects" })
    expect(Object.isFrozen(ADMIN_NAVIGATION)).toBe(true)

    const owned = ADMIN_NAVIGATION.filter((item) => item.moduleId !== undefined)
    expect(owned.map((item) => item.moduleId)).toEqual(["redirects"])
    for (const item of owned) {
      const descriptor = MODULE_CATALOG.find(
        (candidate) => candidate.id === item.moduleId
      )
      expect(descriptor?.required).toBe(false)
      expect(descriptor?.contributions).toContain("admin.navigation")
    }
    expect(() => composeAdminNavigation(ADMIN_NAVIGATION)).not.toThrow()
  })

  it("rejects unknown, required and undeclared owners", () => {
    expect(() =>
      composeAdminNavigation([
        { ...REDIRECTS_NAVIGATION, moduleId: "not-a-module" },
      ])
    ).toThrow(/cannot contribute "admin.navigation"/)
    expect(() =>
      composeAdminNavigation([
        { ...REDIRECTS_NAVIGATION, moduleId: "publication" },
      ])
    ).toThrow(/cannot contribute "admin.navigation"/)

    const undeclared = MODULE_CATALOG.map((descriptor) =>
      descriptor.id === "redirects"
        ? { ...descriptor, contributions: ["public.routing"] }
        : descriptor
    ) as readonly ModuleDescriptorV1[]
    expect(() =>
      composeAdminNavigation([REDIRECTS_NAVIGATION], undeclared)
    ).toThrow(/cannot contribute "admin.navigation"/)
  })

  it("rejects two entries for the same route", () => {
    expect(() =>
      composeAdminNavigation([REDIRECTS_NAVIGATION, REDIRECTS_NAVIGATION])
    ).toThrow(/already has an entry/)
  })
})
