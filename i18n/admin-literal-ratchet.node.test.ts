import { describe, expect, test } from "vitest"
import {
  formatR1LiteralInventory,
  R1_LITERAL_CATEGORIES,
  scanR1LiteralInventory,
  scanR1Source,
} from "./admin-literal-ratchet"

const SETUP_SURFACE_PATHS = new Set([
  "app/(core)/setup/layout.tsx",
  "app/(core)/setup/page.tsx",
  "components/setup/setup-wizard.tsx",
])

const AUTH_SURFACE_PATHS = new Set([
  "app/(core)/(auth)/forgot-password/page.tsx",
  "app/(core)/(auth)/reset-password/page.tsx",
  "app/(core)/(auth)/sign-in/page.tsx",
])

const SHELL_NAVIGATION_COMMAND_PALETTE_PATHS = new Set([
  "components/admin/admin-shell.tsx",
  "components/admin/command-palette.tsx",
  "components/admin/navigation.ts",
  "components/admin/sidebar.tsx",
])

const CONTENT_LIST_NEW_PAGE_FORM_PATHS = new Set([
  "app/(core)/admin/(authenticated)/pages/page.tsx",
  "components/admin/new-page-form.tsx",
  "components/admin/pages-list-client.tsx",
  "components/admin/pages-list-errors.ts",
  "components/admin/pages-list-locales.ts",
  "components/admin/pages-list-row-actions.ts",
  "components/admin/pages-list-snapshot-rows.tsx",
])

const EDITOR_DIALOG_TOAST_PATHS = new Set([
  "app/(core)/admin/(authenticated)/pages/[id]/page.tsx",
  "app/(core)/admin/(authenticated)/pages/[id]/preview/page.tsx",
  "app/(live-preview)/admin/pages/[id]/live-frame/[locale]/actions.ts",
  "app/(live-preview)/admin/pages/[id]/live-frame/[locale]/layout.tsx",
  "app/(live-preview)/admin/pages/[id]/live-frame/[locale]/page.tsx",
  "components/admin/content-type-fields-panel.tsx",
  "components/admin/content-types/use-archived-content-types.tsx",
  "components/admin/duplicate-page-dialog.tsx",
  "components/admin/fields/buttons-editor.tsx",
  "components/admin/fields/field-editor.tsx",
  "components/admin/fields/image-field-editor.tsx",
  "components/admin/fields/relation-picker.tsx",
  "components/admin/import-markdown-dialog.tsx",
  "components/admin/link-picker-dialog.tsx",
  "components/admin/live-preview-frame-bridge.ts",
  "components/admin/live-preview-frame-runtime.tsx",
  "components/admin/live-preview-frame.tsx",
  "components/admin/live-preview-page-type.ts",
  "components/admin/media-browser.tsx",
  "components/admin/media-image-editor.tsx",
  "components/admin/media-picker.tsx",
  "components/admin/page-editor.tsx",
  "components/admin/page-editor/components/page-header-meta.tsx",
  "components/admin/page-editor/components/page-readiness.tsx",
  "components/admin/page-editor/components/pre-publish-checklist.tsx",
  "components/admin/page-editor/components/seo-panel.tsx",
  "components/admin/page-editor/components/settings-panel.tsx",
  "components/admin/page-editor/components/slices-panel.tsx",
  "components/admin/page-editor/components/snapshot-history-panel.tsx",
  "components/admin/page-editor/components/transfer-popover-content.tsx",
  "components/admin/page-editor/hooks/use-page-save.ts",
  "components/admin/page-live-preview.tsx",
  "components/admin/page-live-preview-canvas.tsx",
  "components/admin/preview-inline-document.ts",
  "components/admin/preview-inline-editor.tsx",
  "components/admin/preview-inline-session.ts",
  "components/admin/relation-picker.tsx",
  "components/admin/rich-text-editor.tsx",
  "components/admin/slice-builder.tsx",
  "components/admin/slice-editor.tsx",
  "components/admin/slice-presentation-selector.tsx",
  "components/admin/tag-field.tsx",
  "components/admin/page-editor/lib/pre-publish-readiness.ts",
  "components/admin/page-editor/lib/publication-base.ts",
])

const LANGUAGES_PATHS = new Set([
  "app/(core)/admin/(authenticated)/settings/languages/page.tsx",
  "components/admin/language-transition.tsx",
  "components/admin/languages/default-migration-panel.tsx",
  "components/admin/languages/errors.ts",
  "components/admin/languages/impact-review.tsx",
  "components/admin/languages/languages-screen.tsx",
  "components/admin/languages/language-picker.tsx",
  "components/admin/languages/make-default-dialog.tsx",
  "components/admin/languages/remove-language-dialog.tsx",
  "components/admin/languages/tokens.ts",
  "components/admin/languages/types.ts",
  "components/admin/locale-tabs.tsx",
  "components/admin/multilingual-languages-settings.tsx",
])

const MODULES_PATHS = new Set([
  "app/(core)/admin/(authenticated)/settings/modules/page.tsx",
  "components/admin/modules/modules-settings.tsx",
])

const MENUS_PATHS = new Set([
  "app/(core)/admin/(authenticated)/menus/page.tsx",
  "app/(core)/admin/(authenticated)/menus/[slug]/page.tsx",
  "components/admin/menu/canonical-block-editor.tsx",
  "components/admin/menu/canonical-nav-item-editor.tsx",
  "components/admin/menu/canonical-panel-editor.tsx",
  "components/admin/menu/icon-picker.tsx",
  "components/admin/menu/menu-editor.tsx",
  "components/admin/menu/menu-target-field.tsx",
  "components/admin/menu/menu-validation.tsx",
])

const OTHER_INVENTORY_ROUTES_PATHS = new Set([
  "components/admin/admin-module-state-provider.tsx",
  "components/admin/module-gate.ts",
  "components/admin/optional-module-route.tsx",
  "components/admin/optional-contribution.tsx",
  "app/(core)/(auth)/layout.tsx",
  "app/(core)/(auth)/sign-in/safe-next-path.ts",
  "app/(core)/admin/(authenticated)/archive/page.tsx",
  "app/(core)/admin/(authenticated)/content-types/[type]/page.tsx",
  "app/(core)/admin/(authenticated)/content-types/actions.ts",
  "app/(core)/admin/(authenticated)/content-types/page.tsx",
  "app/(core)/admin/(authenticated)/error.tsx",
  "app/(core)/admin/(authenticated)/layout.tsx",
  "app/(core)/admin/(authenticated)/loading.tsx",
  "app/(core)/admin/(authenticated)/media/page.tsx",
  "app/(core)/admin/(authenticated)/page.tsx",
  "app/(core)/admin/(authenticated)/pages/actions.ts",
  "app/(core)/admin/(authenticated)/pages/new/page.tsx",
  "app/(core)/admin/(authenticated)/redirects/page.tsx",
  "app/(core)/admin/(authenticated)/redirects/redirects-manager.tsx",
  "app/(core)/admin/(authenticated)/settings/account/page.tsx",
  "app/(core)/admin/(authenticated)/settings/actions.ts",
  "app/(core)/admin/(authenticated)/settings/ai/page.tsx",
  "app/(core)/admin/(authenticated)/settings/email/page.tsx",
  "app/(core)/admin/(authenticated)/settings/layout.tsx",
  "app/(core)/admin/(authenticated)/settings/page.tsx",
  "app/(core)/admin/(authenticated)/trash/page.tsx",
  "app/(core)/admin/layout.tsx",
  "app/(core)/layout.tsx",
  "components/admin/admin-contributions.ts",
  "components/admin/archive-list.tsx",
  "components/admin/ai-add-slice-entry.tsx",
  "components/admin/ai-help/help-chat.tsx",
  "components/admin/ai-help/help-errors.ts",
  "components/admin/ai-help/help-participant.tsx",
  "components/admin/ai-settings-model-picker.tsx",
  "components/admin/ai-settings-screen.tsx",
  "components/admin/ai-translation/page-editor-participant.tsx",
  "components/admin/ai-translation/translation-review.tsx",
  "components/admin/ai-writing/new-page-participant.tsx",
  "components/admin/ai-writing/page-jobs.tsx",
  "components/admin/ai-writing/page-wizard.tsx",
  "components/admin/authenticated-admin-shell.tsx",
  "components/admin/content-types/content-type-catalog.tsx",
  "components/admin/content-types/content-type-detail.tsx",
  "components/admin/content-types/content-type-lifecycle-panel.tsx",
  "components/admin/contributions/ai-help.server.ts",
  "components/admin/contributions/ai-help.ts",
  "components/admin/contributions/ai-settings.server.ts",
  "components/admin/contributions/ai-settings.ts",
  "components/admin/contributions/ai-translation.server.ts",
  "components/admin/contributions/ai-translation.ts",
  "components/admin/contributions/ai-writing.server.ts",
  "components/admin/contributions/ai-writing.ts",
  "components/admin/contributions/authoring-tools.server.ts",
  "components/admin/contributions/authoring-tools.ts",
  "components/admin/contributions/authoring-tools.types.ts",
  "components/admin/contributions/forms.ts",
  "components/admin/contributions/history.ts",
  "components/admin/contributions/list-search.ts",
  "components/admin/contributions/types.ts",
  "components/admin/email-settings.tsx",
  "components/admin/fields/editable-kinds.ts",
  "components/admin/fields/field-utils.ts",
  "components/admin/fields/link-page-picker.tsx",
  "components/admin/general-settings.tsx",
  "components/admin/list-row-text.tsx",
  "components/admin/media-library.tsx",
  "components/admin/page-editor/language-notice.ts",
  "components/admin/page-editor/lib/checklist.ts",
  "components/admin/page-editor/lib/content.ts",
  "components/admin/page-editor/lib/descriptor-values.ts",
  "components/admin/page-editor/lib/field-path.ts",
  "components/admin/page-editor/lib/page-draft-handoff.ts",
  "components/admin/page-editor/lib/readiness.ts",
  "components/admin/page-editor/lib/recovery.ts",
  "components/admin/page-editor/lib/repeated-item-identity.ts",
  "components/admin/page-editor/lib/requested-locale.ts",
  "components/admin/page-editor/lib/slice-occurrence.ts",
  "components/admin/page-editor/lib/system-owned-fields.ts",
  "components/admin/page-editor/lib/types.ts",
  "components/admin/preview-inline-headings.ts",
  "components/admin/public-site-updates-row.tsx",
  "components/admin/revalidation-diagnostics.tsx",
  "components/admin/settings/account-language-picker.tsx",
  "components/admin/slice-editor-text.ts",
  "components/admin/trash-list.tsx",
  "components/admin/visual-editing-types.ts",
  "components/edition/page-workflow.tsx",
  "components/edition/roles-manager.tsx",
  "components/edition/workflow-principal.tsx",
  "app/(public)/[locale]/[[...path]]/page.tsx",
  "app/(public)/[locale]/error.tsx",
  "app/(public)/[locale]/layout.tsx",
  "app/(public)/[locale]/loading.tsx",
  "app/(public)/[locale]/not-found.tsx",
  "components/content-types/author.tsx",
  "components/content-types/byline.ts",
  "components/content-types/index.ts",
  "components/content-types/landing-page.tsx",
  "components/content-types/page.tsx",
  "components/content-types/post.tsx",
  "components/content-types/types.ts",
  "components/development-instance-badge.tsx",
  "components/public/footer.tsx",
  "components/public/header-auth-controls.tsx",
  "components/public/mobile-nav.tsx",
  "components/public/navigation/locale-path.ts",
  "components/public/navigation/locale-switcher.tsx",
  "components/public/navigation/main-nav.tsx",
  "components/public/presentation-locale.tsx",
  "components/public/preview-banner.tsx",
  "components/public/public-site-shell.tsx",
  "components/public/site-header.tsx",
  "components/slices/_shared/default-slice-body.tsx",
  "components/slices/faq-simple.tsx",
  "components/slices/features-icon-grid.tsx",
  "components/slices/hero-agency.tsx",
  "components/slices/hero-with-image.tsx",
  "components/slices/presentations/hero-with-image-centered.tsx",
  "components/slices/presentations/registry.tsx",
  "components/slices/render-helpers.tsx",
  "components/slices/rich-text-body.tsx",
  "components/slices/rich-text-content.tsx",
  "components/slices/slice-zone-registry.tsx",
  "components/slices/slice-zone.tsx",
  "components/ui/dialog.tsx",
  "components/ui/sheet.tsx",
  "app/(core)/admin/(authenticated)/slices/[type]/page.tsx",
  "app/(core)/admin/(authenticated)/slices/actions.ts",
  "app/(core)/admin/(authenticated)/slices/ai-actions.ts",
  "app/(core)/admin/(authenticated)/slices/create/actions.ts",
  "app/(core)/admin/(authenticated)/slices/create/create-slice-route.tsx",
  "app/(core)/admin/(authenticated)/slices/create/page.tsx",
  "app/(core)/admin/(authenticated)/slices/gate.ts",
  "app/(core)/admin/(authenticated)/slices/page.tsx",
  "components/admin/page-editor/hooks/use-pre-publish-checklist.ts",
  "components/admin/page-editor/lib/page-inline-draft.ts",
  "components/admin/page-editor/lib/page-save-refused-error.ts",
  "components/admin/slices/create-slice-brief.tsx",
  "components/admin/slices/dev-ai-readiness-notice.tsx",
  "components/admin/slices/slice-card-actions.tsx",
  "components/admin/slices/slice-catalog-grid.tsx",
  "components/admin/slices/slice-lifecycle-panel.tsx",
  "components/admin/slices/slice-presentation-panel.tsx",
  "components/admin/slices/slice-presentation-preview.tsx",
  "components/admin/slices/slice-sim-events.ts",
  "components/admin/slices/use-design-replace.tsx",
  "components/slices/presentations/resolution.ts",
  "components/slices/presentations/site-defaults.ts",
  "components/slices/slice-sim-registry.tsx",
])

describe("admin literal ratchet", () => {
  test("detects every reviewed literal category", () => {
    const findings = scanR1Source(
      `
        const schema = z.string().min(1, "Validation copy")
        const other = {message: "Refine copy", label: "New editable item"}
        const helperLabel = "Helper label"
        function raw(error) { return error.message }
        const implicitDate = new Date().toLocaleString()
        toast.error("Toast copy", {description: "Toast detail"})
        export function Fixture({ready}: {ready: boolean}) {
          return <>
            <p>JSX copy</p>
            <p>{helperLabel}</p>
            <p>{raw(error)}</p>
            <TooltipContent>
              Tooltip copy
              <input aria-label="Accessible copy" placeholder={ready ? "Ready copy" : "Waiting copy"} />
              <span>{ready ? "Enabled copy" : "Disabled copy"}</span>
            </TooltipContent>
          </>
        }
      `,
      "components/admin/fixture.tsx"
    )

    expect(new Set(findings.map((finding) => finding.category))).toEqual(
      new Set(R1_LITERAL_CATEGORIES)
    )
  })

  test("R1 shipped UI has no unallowlisted literals", () => {
    const inventory = scanR1LiteralInventory(process.cwd())
    expect(inventory.files.length).toBeGreaterThan(0)
    expect(inventory.files).toHaveLength(235)
    if (inventory.findings.length > 0) {
      throw new Error(formatR1LiteralInventory(inventory))
    }
  })

  test("setup (D1) has no unallowlisted literals", () => {
    const inventory = scanR1LiteralInventory(process.cwd())
    const setupInventory = {
      ...inventory,
      files: inventory.files.filter(({ shippedPath }) =>
        SETUP_SURFACE_PATHS.has(shippedPath)
      ),
      findings: inventory.findings.filter(({ path }) =>
        SETUP_SURFACE_PATHS.has(path)
      ),
      allowed: inventory.allowed.filter(({ finding }) =>
        SETUP_SURFACE_PATHS.has(finding.path)
      ),
    }
    expect(setupInventory.files).toHaveLength(3)
    if (setupInventory.findings.length > 0) {
      throw new Error(formatR1LiteralInventory(setupInventory))
    }
  })

  test("sign-in, forgot, and reset have no unallowlisted literals", () => {
    const inventory = scanR1LiteralInventory(process.cwd())
    const authInventory = {
      ...inventory,
      files: inventory.files.filter(({ shippedPath }) =>
        AUTH_SURFACE_PATHS.has(shippedPath)
      ),
      findings: inventory.findings.filter(({ path }) =>
        AUTH_SURFACE_PATHS.has(path)
      ),
      allowed: inventory.allowed.filter(({ finding }) =>
        AUTH_SURFACE_PATHS.has(finding.path)
      ),
    }
    expect(authInventory.files).toHaveLength(3)
    if (authInventory.findings.length > 0) {
      throw new Error(formatR1LiteralInventory(authInventory))
    }
  })

  test("shell, navigation, and command palette have no unallowlisted literals", () => {
    const inventory = scanR1LiteralInventory(process.cwd())
    const shellInventory = {
      ...inventory,
      files: inventory.files.filter(({ shippedPath }) =>
        SHELL_NAVIGATION_COMMAND_PALETTE_PATHS.has(shippedPath)
      ),
      findings: inventory.findings.filter(({ path }) =>
        SHELL_NAVIGATION_COMMAND_PALETTE_PATHS.has(path)
      ),
      allowed: inventory.allowed.filter(({ finding }) =>
        SHELL_NAVIGATION_COMMAND_PALETTE_PATHS.has(finding.path)
      ),
    }
    expect(shellInventory.files).toHaveLength(4)
    if (shellInventory.findings.length > 0) {
      throw new Error(formatR1LiteralInventory(shellInventory))
    }
  })

  test("content list and new-page form have no unallowlisted literals", () => {
    const inventory = scanR1LiteralInventory(process.cwd())
    const contentListInventory = {
      ...inventory,
      files: inventory.files.filter(({ shippedPath }) =>
        CONTENT_LIST_NEW_PAGE_FORM_PATHS.has(shippedPath)
      ),
      findings: inventory.findings.filter(({ path }) =>
        CONTENT_LIST_NEW_PAGE_FORM_PATHS.has(path)
      ),
      allowed: inventory.allowed.filter(({ finding }) =>
        CONTENT_LIST_NEW_PAGE_FORM_PATHS.has(finding.path)
      ),
    }
    expect(contentListInventory.files).toHaveLength(7)
    if (contentListInventory.findings.length > 0) {
      throw new Error(formatR1LiteralInventory(contentListInventory))
    }
  })

  test("editor, dialogs, and toasts have no unallowlisted literals", () => {
    const inventory = scanR1LiteralInventory(process.cwd())
    const editorInventory = {
      ...inventory,
      files: inventory.files.filter(({ shippedPath }) =>
        EDITOR_DIALOG_TOAST_PATHS.has(shippedPath)
      ),
      findings: inventory.findings.filter(({ path }) =>
        EDITOR_DIALOG_TOAST_PATHS.has(path)
      ),
      allowed: inventory.allowed.filter(({ finding }) =>
        EDITOR_DIALOG_TOAST_PATHS.has(finding.path)
      ),
    }
    expect(editorInventory.files).toHaveLength(44)
    if (editorInventory.findings.length > 0) {
      throw new Error(formatR1LiteralInventory(editorInventory))
    }
  })

  test("Languages has no unallowlisted literals", () => {
    const inventory = scanR1LiteralInventory(process.cwd())
    const languagesInventory = {
      ...inventory,
      files: inventory.files.filter(({ shippedPath }) =>
        LANGUAGES_PATHS.has(shippedPath)
      ),
      findings: inventory.findings.filter(({ path }) =>
        LANGUAGES_PATHS.has(path)
      ),
      allowed: inventory.allowed.filter(({ finding }) =>
        LANGUAGES_PATHS.has(finding.path)
      ),
    }
    expect(languagesInventory.files).toHaveLength(13)
    if (languagesInventory.findings.length > 0) {
      throw new Error(formatR1LiteralInventory(languagesInventory))
    }
  })

  test("Modules has no unallowlisted literals", () => {
    const inventory = scanR1LiteralInventory(process.cwd())
    const modulesInventory = {
      ...inventory,
      files: inventory.files.filter(({ shippedPath }) =>
        MODULES_PATHS.has(shippedPath)
      ),
      findings: inventory.findings.filter(({ path }) =>
        MODULES_PATHS.has(path)
      ),
      allowed: inventory.allowed.filter(({ finding }) =>
        MODULES_PATHS.has(finding.path)
      ),
    }
    expect(modulesInventory.files).toHaveLength(2)
    if (modulesInventory.findings.length > 0) {
      throw new Error(formatR1LiteralInventory(modulesInventory))
    }
  })

  test("Menus has no unallowlisted literals", () => {
    const inventory = scanR1LiteralInventory(process.cwd())
    const menusInventory = {
      ...inventory,
      files: inventory.files.filter(({ shippedPath }) =>
        MENUS_PATHS.has(shippedPath)
      ),
      findings: inventory.findings.filter(({ path }) => MENUS_PATHS.has(path)),
      allowed: inventory.allowed.filter(({ finding }) =>
        MENUS_PATHS.has(finding.path)
      ),
    }
    expect(menusInventory.files).toHaveLength(9)
    if (menusInventory.findings.length > 0) {
      throw new Error(formatR1LiteralInventory(menusInventory))
    }
  })

  test("other inventory routes have no unallowlisted literals", () => {
    const inventory = scanR1LiteralInventory(process.cwd())
    const completedPaths = new Set([
      ...SETUP_SURFACE_PATHS,
      ...AUTH_SURFACE_PATHS,
      ...SHELL_NAVIGATION_COMMAND_PALETTE_PATHS,
      ...CONTENT_LIST_NEW_PAGE_FORM_PATHS,
      ...EDITOR_DIALOG_TOAST_PATHS,
      ...LANGUAGES_PATHS,
      ...MODULES_PATHS,
      ...MENUS_PATHS,
    ])
    const expectedOtherInventoryRoutes = new Set(
      inventory.files
        .map(({ shippedPath }) => shippedPath)
        .filter((shippedPath) => !completedPaths.has(shippedPath))
    )
    expect(OTHER_INVENTORY_ROUTES_PATHS).toEqual(expectedOtherInventoryRoutes)
    const otherInventoryRoutes = {
      ...inventory,
      files: inventory.files.filter(({ shippedPath }) =>
        OTHER_INVENTORY_ROUTES_PATHS.has(shippedPath)
      ),
      findings: inventory.findings.filter(({ path }) =>
        OTHER_INVENTORY_ROUTES_PATHS.has(path)
      ),
      allowed: inventory.allowed.filter(({ finding }) =>
        OTHER_INVENTORY_ROUTES_PATHS.has(finding.path)
      ),
    }
    expect(otherInventoryRoutes.files).toHaveLength(150)
    if (otherInventoryRoutes.findings.length > 0) {
      throw new Error(formatR1LiteralInventory(otherInventoryRoutes))
    }
  })
})
