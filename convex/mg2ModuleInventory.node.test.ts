import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { expect, test } from "vitest"

// Exact seat-reviewed C6 list (resume 1 A–C); new entries require classification.
export const C6_INVENTORY = {
  "convex/cms/modules.ts": {
    effective: "core module state",
    preview: "Apply lifecycle",
    commit: "Apply lifecycle",
  },
  "convex/cms/multilingual.ts": {
    getMultilingualState: "core language/F09",
    previewAdoption: "guarded setup",
    adoptMultilingualAuthority: "guarded setup",
    returnToSingleLanguage: "guarded setup",
    addLanguage: "guarded module work",
    removeLanguage: "guarded module work",
    needsReviewToAddLanguage: "guarded module work",
    addSiteLanguage: "guarded module work",
    prepareLanguageReview: "guarded module work",
    prepareLanguageChange: "guarded module work",
    removeLastExtraLanguage: "guarded module work",
    startLanguageImpactPreview: "guarded module work",
    stepLanguageImpactPreview: "guarded module work",
    expireLanguageImpactPreview: "core retained-data cleanup",
    listLanguageImpact: "guarded module work",
    recordLanguageImpactReview: "guarded module work",
    startDefaultLanguageMigration: "guarded module work",
    setDefaultLanguage: "guarded module work",
    stepDefaultLanguageMigration: "guarded module work",
    continueDefaultLanguageMigration: "guarded module work",
    listDefaultLanguageRoutes: "guarded module work",
    listDefaultMigrationDisclosure: "guarded module work",
    recordDefaultMigrationReview: "guarded module work",
    activateDefaultLanguageMigration: "guarded module work",
    cancelDefaultLanguageMigration: "guarded module work",
  },
  "convex/cms/language.ts": {
    initializeSiteLanguageAuthority: "core language/F09",
    getLanguageState: "core language/F09",
    listLanguageTransitionPages: "core language/F09",
    listLanguageCarryDecisions: "core language/F09",
    getSourcePublicationNotice: "core language/F09",
    getRetainedTargetDraftRemedy: "core language/F09",
    deleteRetainedTargetDraft: "core language/F09",
    startLanguageTransition: "core language/F09",
    stepLanguageTransition: "core language/F09",
    continueLanguageTransition: "core language/F09",
    prepareTransitionPage: "core language/F09",
    prepareTargetPage: "core language/F09",
    setPageDisposition: "core language/F09",
    copySourceToTargetDraft: "core language/F09",
    confirmTargetContent: "core language/F09",
    confirmTransitionPreview: "core language/F09",
    validateLanguageTransition: "core language/F09",
    activateLanguageTransition: "core language/F09",
    cancelLanguageTransition: "core language/F09",
    withdrawTransitionTarget: "core language/F09",
    discardTransitionTargetDraft: "core language/F09",
  },
  "convex/cms/languageLifecycle.ts": {
    claimLanguageLifecycleIntents: "core language/F09",
    planLanguageLifecycleStep: "core language/F09",
    advanceLanguageLifecycleIntent: "core language/F09",
    restartLanguageLifecycleIntent: "core language/F09",
    markLanguageLifecycleIntentUnconfigured: "core language/F09",
    markLanguageLifecycleIntentLocalUnreachable: "core language/F09",
    failLanguageLifecycleIntent: "core language/F09",
    releaseLanguageLifecycleIntent: "core language/F09",
    readLanguageLifecycleOrigin: "core language/F09",
    readLanguageLifecycleClaim: "core language/F09",
    drainLanguageLifecycleIntents: "core language/F09",
    rearmUndeliveredLifecycleIntents: "core language/F09",
    requeueUndeliveredLifecycleIntents: "core language/F09",
    getLanguageLifecycleStatus: "core language/F09",
    collectDefaultLanguageRoutes: "core language/F09",
    sweepDefaultLanguageCollection: "core language/F09",
  },
  "convex/cms/redirects.ts": {
    resolve: "public RG9",
    listActiveKeys: "public RG9",
    list: "guarded module work",
    listPaginated: "guarded module work",
    create: "guarded module work",
    remove: "guarded module work",
  },
} as const
const registrars = new Set([
  "query",
  "mutation",
  "action",
  "internalQuery",
  "internalMutation",
  "internalAction",
])
function registrations(path: string) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true
  )
  const found: Record<string, string> = {}
  for (const node of source.statements) {
    if (!ts.isVariableStatement(node)) continue
    for (const declaration of node.declarationList.declarations) {
      const init = declaration.initializer
      if (
        init &&
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        registrars.has(init.expression.text)
      )
        found[declaration.name.getText(source)] = init.getText(source)
    }
  }
  return found
}
for (const [file, classified] of Object.entries(C6_INVENTORY)) {
  test(`C6 exact registrations: ${file}`, () => {
    const actual = registrations(file)
    expect(Object.keys(actual).sort()).toEqual(Object.keys(classified).sort())
    for (const [name, category] of Object.entries(classified)) {
      if (category.startsWith("core") || category === "public RG9") {
        expect(actual[name]).not.toContain("requireOwnerAndOptionalModule(")
        expect(actual[name]).not.toContain("canRunMultilingualStep(")
      }
    }
  })
  for (const [name, category] of Object.entries(classified)) {
    if (category !== "guarded module work" && category !== "guarded setup")
      continue
    test(`C6 shared guard: ${file}:${name}`, () => {
      const body = registrations(file)[name]
      if (
        name === "stepLanguageImpactPreview" ||
        name === "stepDefaultLanguageMigration"
      )
        expect(body).toContain("canRunMultilingualStep(ctx)")
      else {
        expect(body).toContain("requireOwnerAndOptionalModule(ctx,")
        const ownerCheck = file.endsWith("redirects.ts")
          ? "requireOperationAccess(ctx)"
          : "requireInstallationOwner(ctx)"
        expect(body).toContain(ownerCheck)
        expect(body.indexOf(ownerCheck)).toBeLessThan(
          body.indexOf("requireOwnerAndOptionalModule(ctx,")
        )
        if (category === "guarded setup")
          expect(body).toContain("requireReady: false")
      }
    })
  }
}
function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((item) =>
    item.name === "_generated"
      ? []
      : item.isDirectory()
        ? productionFiles(join(directory, item.name))
        : item.name.endsWith(".ts") && !item.name.includes(".test.")
          ? [join(directory, item.name)]
          : []
  )
}
test("Modules commit is the only production flag-writer caller", () => {
  const callers: string[] = []
  for (const file of productionFiles("convex")) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true
    )
    function walk(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "commitModuleTransitionInTransaction"
      )
        callers.push(file)
      ts.forEachChild(node, walk)
    }
    walk(source)
  }
  expect(callers).toEqual(["convex/cms/modules.ts"])
})
