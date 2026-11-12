import { describe, expect, it } from "vitest"
import {
  MODULE_CATALOG,
  assertModuleCanBeDisabled,
  validateModuleCatalog,
  validateModuleConfig,
} from "./catalog"
import {
  CURRENT_MODULE_CONFIG_VERSION,
  CURRENT_MODULE_DESCRIPTOR_VERSION,
  MODULE_CONTRIBUTION_IDS,
  MODULE_ENVIRONMENTS,
  type ModuleConfigV1,
  type ModuleDescriptorV1,
} from "./types"

function descriptor(
  overrides: Partial<ModuleDescriptorV1> = {}
): ModuleDescriptorV1 {
  return {
    id: "example-module",
    name: "Example module",
    summary: "A fixture for static module validation.",
    descriptorVersion: CURRENT_MODULE_DESCRIPTOR_VERSION,
    configVersion: CURRENT_MODULE_CONFIG_VERSION,
    required: false,
    dependencies: [],
    environments: ["browser"],
    contributions: ["admin.navigation"],
    ...overrides,
  }
}

describe("static module catalog validation", () => {
  it("declares the exact current environment and contribution vocabulary", () => {
    expect(MODULE_ENVIRONMENTS).toEqual(["browser", "server", "worker"])
    expect(MODULE_CONTRIBUTION_IDS).toEqual([
      "publication.policy",
      "publication.history",
      "publication.index",
      "delivery.outbound",
      "publication.scheduling",
      "admin.navigation",
      "admin.settings",
      "admin.page-editor",
      "admin.page-history",
      "admin.ai-settings",
      "admin.ai-writing",
      "admin.ai-translation",
      "admin.ai-help",
      "admin.list-search",
      "admin.sidebar-status",
      "content.slice",
      "public.action",
      "public.routing",
    ])
  })

  it("contains the reviewed required modules and sole pilot", () => {
    expect(validateModuleCatalog(MODULE_CATALOG).map(({ id }) => id)).toEqual([
      "system",
      "owner-access",
      "content-model",
      "content-editor",
      "publication",
      "media",
      "language",
      "email",
      "redirects",
      "multilingual",
      "ai",
    ])
  })

  it("does not present planned modules as installed owner-configurable modules", () => {
    expect(
      MODULE_CATALOG.filter((module) => !module.required).map(
        (module) => module.id
      )
    ).toEqual(["redirects", "multilingual", "ai"])
  })

  it("closes the exact reviewed descriptor metadata for all eleven entries", () => {
    expect(MODULE_CATALOG).toEqual([
      {
        id: "system",
        name: "System",
        summary: "Core shell, setup, and shared technical foundations.",
        descriptorVersion: 1,
        configVersion: 1,
        required: true,
        dependencies: [],
        environments: ["browser", "server"],
        contributions: [],
      },
      {
        id: "owner-access",
        name: "Owner access",
        summary: "Durable installation-owner identity and protected access.",
        descriptorVersion: 1,
        configVersion: 1,
        required: true,
        dependencies: ["system"],
        environments: ["browser", "server", "worker"],
        contributions: [],
      },
      {
        id: "content-model",
        name: "Content model",
        summary:
          "Typed content definitions, fields, and content relationships.",
        descriptorVersion: 1,
        configVersion: 1,
        required: true,
        dependencies: ["system", "owner-access"],
        environments: ["browser", "server"],
        contributions: [],
      },
      {
        id: "content-editor",
        name: "Content editor",
        summary:
          "Draft editing, page authoring, and editor-facing content tools.",
        descriptorVersion: 1,
        configVersion: 1,
        required: true,
        dependencies: ["content-model", "owner-access"],
        environments: ["browser", "server", "worker"],
        contributions: [],
      },
      {
        id: "publication",
        name: "Publication",
        summary:
          "Validated publication and public content delivery foundations.",
        descriptorVersion: 1,
        configVersion: 1,
        required: true,
        dependencies: ["content-editor", "content-model", "owner-access"],
        environments: ["browser", "server", "worker"],
        contributions: [],
      },
      {
        id: "media",
        name: "Media",
        summary:
          "Owned media storage, editing, and reference-safe asset access.",
        descriptorVersion: 1,
        configVersion: 1,
        required: true,
        dependencies: ["content-model", "owner-access"],
        environments: ["browser", "server"],
        contributions: [],
      },
      {
        id: "language",
        name: "Language",
        summary:
          "The Community site-language foundation and admin language settings.",
        descriptorVersion: 1,
        configVersion: 1,
        required: true,
        dependencies: ["publication", "owner-access"],
        environments: ["browser", "server", "worker"],
        contributions: [],
      },
      {
        id: "email",
        name: "Email",
        summary: "Recovery and transactional email configuration foundations.",
        descriptorVersion: 1,
        configVersion: 1,
        required: true,
        dependencies: ["system", "owner-access"],
        environments: ["browser", "server", "worker"],
        contributions: [],
      },
      {
        id: "redirects",
        name: "Redirects",
        summary: "Owner-authored manual redirect rules for public routing.",
        descriptorVersion: 1,
        configVersion: 1,
        required: false,
        dependencies: ["system", "owner-access", "publication"],
        environments: ["browser", "server"],
        contributions: ["admin.navigation", "public.routing"],
      },
      {
        id: "multilingual",
        name: "Multilingual",
        summary: "Publish your site in more than one language.",
        descriptorVersion: 1,
        configVersion: 1,
        required: false,
        dependencies: ["language", "publication", "owner-access"],
        environments: ["browser", "server", "worker"],
        contributions: [
          "admin.settings",
          "admin.page-editor",
          "public.routing",
        ],
      },
      {
        id: "ai",
        name: "AI",
        summary: "Writing, translation and help assistants in the admin. Providers, models and instructions are set in Settings › AI. Translation also requires Multilingual. Content sent to an assistant goes to its provider, which bills you per use.",
        descriptorVersion: 1,
        configVersion: 1,
        required: false,
        dependencies: ["system", "owner-access", "content-editor"],
        environments: ["browser", "server", "worker"],
        contributions: [
          "admin.ai-settings",
          "admin.ai-writing",
          "admin.ai-translation",
          "admin.ai-help",
        ],
      },
    ])
  })

  it("returns descriptors after their declared dependencies", () => {
    const publication = descriptor({ id: "publication" })
    const redirects = descriptor({
      id: "redirects",
      dependencies: ["publication"],
    })

    expect(
      validateModuleCatalog([redirects, publication]).map(({ id }) => id)
    ).toEqual(["publication", "redirects"])
  })

  it("keeps required-module metadata immutable at runtime", () => {
    expect(Object.isFrozen(MODULE_CATALOG)).toBe(true)
    expect(
      MODULE_CATALOG.every(
        (module) =>
          Object.isFrozen(module) &&
          Object.isFrozen(module.dependencies) &&
          Object.isFrozen(module.environments) &&
          Object.isFrozen(module.contributions)
      )
    ).toBe(true)
    expect(Reflect.set(MODULE_CATALOG[0], "required", false)).toBe(false)
    expect(() => assertModuleCanBeDisabled("system")).toThrow(
      /Required module "system" is fixed active/
    )
  })

  it.each([
    ["invalid stable ID", [descriptor({ id: "Not stable" })]],
    ["duplicate IDs", [descriptor(), descriptor()]],
    ["unknown dependency", [descriptor({ dependencies: ["missing-module"] })]],
    [
      "required dependency on an owner-configured module",
      [
        descriptor({ id: "optional-foundation" }),
        descriptor({
          id: "required-consumer",
          required: true,
          dependencies: ["optional-foundation"],
        }),
      ],
    ],
    [
      "duplicate dependencies",
      [
        descriptor({ id: "foundation" }),
        descriptor({
          id: "consumer",
          dependencies: ["foundation", "foundation"],
        }),
      ],
    ],
    [
      "cyclic dependencies",
      [
        descriptor({ id: "first", dependencies: ["second"] }),
        descriptor({ id: "second", dependencies: ["first"] }),
      ],
    ],
    [
      "unsupported descriptor version",
      [descriptor({ descriptorVersion: 2 as never })],
    ],
    ["unsupported config version", [descriptor({ configVersion: 2 as never })]],
    [
      "unsupported environment",
      [descriptor({ environments: ["edge" as never] })],
    ],
    [
      "duplicate environments",
      [descriptor({ environments: ["browser", "browser"] })],
    ],
    [
      "unsupported contribution",
      [descriptor({ contributions: ["generic.hook" as never] })],
    ],
    [
      "duplicate contributions",
      [
        descriptor({
          contributions: ["admin.navigation", "admin.navigation"],
        }),
      ],
    ],
  ])("rejects %s", (_reason, descriptors) => {
    expect(() => validateModuleCatalog(descriptors)).toThrow()
  })

  it("accepts only a matching current typed configuration envelope", () => {
    const moduleDescriptor = descriptor({ id: "redirects" })
    const config: ModuleConfigV1<{ retainHistory: boolean }> = {
      moduleId: "redirects",
      configVersion: CURRENT_MODULE_CONFIG_VERSION,
      values: { retainHistory: true },
    }

    expect(validateModuleConfig(moduleDescriptor, config)).toBe(config)
    expect(() =>
      validateModuleConfig(moduleDescriptor, {
        ...config,
        moduleId: "publication",
      })
    ).toThrow(/does not match descriptor/)
    expect(() =>
      validateModuleConfig(moduleDescriptor, {
        ...config,
        configVersion: 2 as never,
      })
    ).toThrow(/unsupported config version/)
  })

  it("rejects required-disable requests against registered metadata", () => {
    expect(() => assertModuleCanBeDisabled("system")).toThrow(
      /Required module "system" is fixed active/
    )
    expect(() => assertModuleCanBeDisabled("redirects")).not.toThrow()
    expect(() => assertModuleCanBeDisabled("not-installed")).toThrow(
      /not in the current catalog/
    )

    const callerForgedRequiredFlag = {
      ...MODULE_CATALOG[0],
      required: false,
    } as ModuleDescriptorV1
    expect(callerForgedRequiredFlag.required).toBe(false)
    expect(() =>
      assertModuleCanBeDisabled(callerForgedRequiredFlag.id)
    ).toThrow(/Required module "system" is fixed active/)
  })
})
