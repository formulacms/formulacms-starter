/// <reference types="vite/client" />
import { describe, expect, it } from "vitest"
import { MODULE_CATALOG } from "../../lib/modules/catalog"
import type { ModuleDescriptorV1 } from "../../lib/modules/types"
import {
  ADMIN_CONTRIBUTION_SLOTS,
  type AdminContributionSlot,
  INSTALLED_ADMIN_CONTRIBUTIONS,
  composeAdminContributions,
  isAdminContributionInstalled,
} from "./admin-contributions"
import { ADMIN_AI_HELP_BROWSER_BINDING } from "./contributions/ai-help"
import { ADMIN_AI_HELP_SERVER_BINDING } from "./contributions/ai-help.server"
import { ADMIN_AI_SETTINGS_BROWSER_BINDING } from "./contributions/ai-settings"
import { ADMIN_AI_SETTINGS_SERVER_BINDING } from "./contributions/ai-settings.server"
import { ADMIN_AI_TRANSLATION_BROWSER_BINDING } from "./contributions/ai-translation"
import { ADMIN_AI_TRANSLATION_SERVER_BINDING } from "./contributions/ai-translation.server"
import { ADMIN_AI_WRITING_BROWSER_BINDING } from "./contributions/ai-writing"
import { ADMIN_AI_WRITING_SERVER_BINDING } from "./contributions/ai-writing.server"
import { ADMIN_FORMS_BROWSER_BINDING } from "./contributions/forms"
import { ADMIN_LIST_SEARCH_BROWSER_BINDING } from "./contributions/list-search"

const optionalSearch: ModuleDescriptorV1 = {
  id: "search-fixture",
  name: "Search fixture",
  summary: "Test-only optional module that declares list search.",
  descriptorVersion: 1,
  configVersion: 1,
  required: false,
  dependencies: ["system"],
  environments: ["browser"],
  contributions: ["admin.list-search"],
}
const fixtureCatalog = [...MODULE_CATALOG, optionalSearch]

describe("installed admin contribution profile (F08d)", () => {
  it("installs only the Settings AI, Writing, Translation and Help participants", () => {
    expect(Object.keys(INSTALLED_ADMIN_CONTRIBUTIONS).sort()).toEqual(
      [...ADMIN_CONTRIBUTION_SLOTS].sort()
    )
    for (const slot of ADMIN_CONTRIBUTION_SLOTS) {
      if (
        slot === "admin.ai-settings" ||
        slot === "admin.ai-writing" ||
        slot === "admin.ai-translation" ||
        slot === "admin.ai-help"
      ) {
        expect(INSTALLED_ADMIN_CONTRIBUTIONS[slot]).toEqual({ moduleId: "ai", contribution: slot })
        expect(isAdminContributionInstalled(slot)).toBe(true)
      } else {
        expect(INSTALLED_ADMIN_CONTRIBUTIONS[slot]).toBeNull()
        expect(isAdminContributionInstalled(slot)).toBe(false)
      }
    }
    expect(Object.isFrozen(INSTALLED_ADMIN_CONTRIBUTIONS)).toBe(true)
  })

  it("keeps every AI browser/server binding in agreement with its profile slot", () => {
    const cases = [
      {
        slot: "admin.ai-settings" as const,
        bindings: [
          ADMIN_AI_SETTINGS_BROWSER_BINDING,
          ADMIN_AI_SETTINGS_SERVER_BINDING,
        ],
      },
      {
        slot: "admin.ai-writing" as const,
        bindings: [
          ADMIN_AI_WRITING_BROWSER_BINDING,
          ADMIN_AI_WRITING_SERVER_BINDING,
        ],
      },
      {
        slot: "admin.ai-translation" as const,
        bindings: [
          ADMIN_AI_TRANSLATION_BROWSER_BINDING,
          ADMIN_AI_TRANSLATION_SERVER_BINDING,
        ],
      },
      {
        slot: "admin.ai-help" as const,
        bindings: [ADMIN_AI_HELP_BROWSER_BINDING, ADMIN_AI_HELP_SERVER_BINDING],
      },
    ]

    expect(cases.map(({ slot }) => slot)).toEqual(
      ADMIN_CONTRIBUTION_SLOTS.filter((slot) => slot.startsWith("admin.ai-"))
    )

    for (const { slot, bindings } of cases) {
      const profileHasParticipant = INSTALLED_ADMIN_CONTRIBUTIONS[slot] !== null
      for (const binding of bindings) {
        expect(binding !== null, `${slot} binding`).toBe(profileHasParticipant)
      }
    }
  })

  it("keeps the Search and Forms bindings in agreement with their profile slots (FR2b)", () => {
    for (const [slot, binding] of [
      ["admin.list-search", ADMIN_LIST_SEARCH_BROWSER_BINDING],
      ["admin.sidebar-status", ADMIN_FORMS_BROWSER_BINDING],
    ] as const) {
      expect(binding !== null, `${slot} binding`).toBe(
        INSTALLED_ADMIN_CONTRIBUTIONS[slot] !== null
      )
    }
  })

  it("keeps every contributions binding null exactly when its slot is empty (FR2c)", () => {
    const bindingSlots: Record<string, AdminContributionSlot> = {
      "ai-help.ts": "admin.ai-help",
      "ai-help.server.ts": "admin.ai-help",
      "ai-settings.ts": "admin.ai-settings",
      "ai-settings.server.ts": "admin.ai-settings",
      "ai-translation.ts": "admin.ai-translation",
      "ai-translation.server.ts": "admin.ai-translation",
      "ai-writing.ts": "admin.ai-writing",
      "ai-writing.server.ts": "admin.ai-writing",
      "forms.ts": "admin.sidebar-status",
      "history.ts": "admin.page-history",
      "list-search.ts": "admin.list-search",
    }
    // Mechanism-2 overlay seams (FR2.0 rev2 S-f) have no catalog slot: source
    // keeps the local slice library, and the starter overlay twin is `null`
    // (scripts/starter/authoring-tools-seam.test.ts). They stay out of the
    // eager import so this test never loads source-only authoring code.
    const overlaySeams = new Set([
      "authoring-tools.ts",
      "authoring-tools.server.ts",
      "authoring-tools.types.ts",
    ])
    const files = Object.keys(import.meta.glob("./contributions/*.ts"))
      .map((path) => path.split("/").at(-1)!)
      .filter((file) => file !== "types.ts" && !overlaySeams.has(file))
    const bindingModules = Object.entries(
      import.meta.glob(
        ["./contributions/*.ts", "!./contributions/authoring-tools*.ts"],
        { eager: true }
      ) as Record<string, Record<string, unknown>>
    )
      .map(([path, module]) => [path.split("/").at(-1)!, module] as const)
      .filter(([file]) => file !== "types.ts")

    // A binding file with no declared slot fails instead of escaping the check.
    expect(files.sort()).toEqual(Object.keys(bindingSlots).sort())
    expect(bindingModules.map(([file]) => file).sort()).toEqual(
      Object.keys(bindingSlots).sort()
    )
    for (const [file, module] of bindingModules) {
      const bindings = Object.entries(module).filter(([name]) =>
        /^ADMIN_[A-Z_]+_BINDING$/.test(name)
      )
      expect(bindings, `${file} exports one binding`).toHaveLength(1)
      const slot = bindingSlots[file]!
      expect(bindings[0]![1] !== null, `${file} binding`).toBe(
        INSTALLED_ADMIN_CONTRIBUTIONS[slot] !== null
      )
    }
  })

  it("keeps the History slot apart from the Multilingual page-editor contribution (FR2c)", () => {
    expect(ADMIN_CONTRIBUTION_SLOTS).toContain("admin.page-history")
    expect(ADMIN_CONTRIBUTION_SLOTS).not.toContain("admin.page-editor" as never)
    for (const contribution of ["admin.page-history", "admin.page-editor"]) {
      expect(() =>
        composeAdminContributions([
          {
            moduleId: "multilingual",
            contribution: contribution as AdminContributionSlot,
          },
        ])
      ).toThrow(/cannot contribute/)
    }
  })

  it("accepts an optional catalog module that declares the slot", () => {
    const profile = composeAdminContributions(
      [{ moduleId: "search-fixture", contribution: "admin.list-search" }],
      fixtureCatalog
    )

    expect(profile["admin.list-search"]).toEqual({
      moduleId: "search-fixture",
      contribution: "admin.list-search",
    })
    expect(isAdminContributionInstalled("admin.list-search", profile)).toBe(
      true
    )
    expect(isAdminContributionInstalled("admin.sidebar-status", profile)).toBe(
      false
    )
  })

  it("rejects required, unknown and undeclared owners", () => {
    expect(() =>
      composeAdminContributions(
        [{ moduleId: "media", contribution: "admin.list-search" }],
        fixtureCatalog
      )
    ).toThrow(/cannot contribute/)
    expect(() =>
      composeAdminContributions(
        [{ moduleId: "forms", contribution: "admin.sidebar-status" }],
        fixtureCatalog
      )
    ).toThrow(/cannot contribute/)
    expect(() =>
      composeAdminContributions(
        [{ moduleId: "search-fixture", contribution: "admin.page-history" }],
        fixtureCatalog
      )
    ).toThrow(/cannot contribute/)
    expect(() =>
      composeAdminContributions(
        [
          {
            moduleId: "redirects",
            contribution: "admin.navigation" as never,
          },
        ],
        fixtureCatalog
      )
    ).toThrow(/cannot contribute/)
  })

  it("rejects a second participant for the same slot", () => {
    expect(() =>
      composeAdminContributions(
        [
          { moduleId: "search-fixture", contribution: "admin.list-search" },
          { moduleId: "search-fixture", contribution: "admin.list-search" },
        ],
        fixtureCatalog
      )
    ).toThrow(/already has a participant/)
  })
})
