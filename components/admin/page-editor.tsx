"use client"

import { usePageAddressMessages } from "@/lib/admin/page-address-messages"

import type { HistoryRestoreResult } from "./contributions/history"
import { readSlice } from "@/convex/lib/slices/identity"

import {
  adoptHeroTitles,
  prepareHeroTitleDraft,
  mergeTitleReports,
} from "@/lib/rich-text/adopt-hero-titles"
import {
  writeSliceFields,
  type TitleWriteReport,
} from "@/convex/lib/richtext/write"
import {
  useState,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  type SetStateAction,
} from "react"
import { flushSync } from "react-dom"
import {
  useMutation,
  useQuery,
  useConvex,
  type ReactMutation,
} from "convex/react"
import { api } from "@/convex/_generated/api"
import { useRouter } from "next/navigation"
import { useLocale, useTranslations } from "next-intl"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { getContentDefault } from "@/lib/i18n/content-defaults"
import { toast } from "sonner"
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  Settings,
  Layers,
  Search,
  Archive,
  Copy,
  CopyPlus,
  ExternalLink,
  MoreHorizontal,
  PlusCircle,
  AlertTriangle,
  CircleAlert,
  Save,
  History,
  Lock,
  Trash2,
  Users,
  Upload,
  ArchiveRestore,
  Loader2,
} from "lucide-react"
import { LocaleTabs } from "./locale-tabs"
import {
  languageChangeEditorNotice,
  sourcePublicationWarning,
} from "./page-editor/language-notice"
import type {
  PreviewActiveEditHandle,
  PreviewFieldSelection,
  PreviewInlineActivationResult,
  PreviewInlineRefusalReason,
  PreviewInlineEditCommit,
  SliceFieldFocusTarget,
  SliceFirstControlFocusTarget,
} from "./visual-editing-types"
import { useConfirm } from "@/components/providers/confirm-provider"
import { DuplicatePageDialog } from "@/components/admin/duplicate-page-dialog"
import { siteLocaleOrder } from "@/components/admin/pages-list-locales"
import {
  UnpublishDialog,
  unpublishRequest,
  type UnpublishRequest,
} from "@/components/admin/pages-list-snapshot-rows"
import { Badge } from "@/components/ui/badge"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { canonicalPathForPage, toPublicPath } from "@/lib/pages/url"
import { destructiveRefusalMessage } from "@/lib/admin/destructive-refusal"
import {
  clearPageDraftHandoff,
  readPageDraftHandoff,
} from "./page-editor/lib/page-draft-handoff"
import {
  clearRecoveryDraft,
  readRecoveryDraft,
  isCurrentSourceRecovery,
  isRecoveryBaseCurrent,
  parseRecoveryBase,
  writeCapturedRecoveryDraft,
} from "./page-editor/lib/recovery"
import {
  useRegisterAdminCommands,
  type AdminCommand,
} from "@/components/admin/command-palette"
import type { Id } from "@/convex/_generated/dataModel"
import { type Slice } from "@/convex/lib/slices"
import { hasSliceBody } from "@/convex/lib/pages/sliceBodyContent"
import { getLocaleDisplayName, type Locale } from "@/lib/i18n/config"
import {
  type ActivePanel,
  type LocaleContentSummary,
  type LocaleDraft,
  type Page,
  type PageEditorRecoveryDraft,
  type PageSummaryRow,
  type TranslateMode,
  staleSaveMessage,
} from "./page-editor/lib/types"
import { PageReadinessTrigger } from "./page-editor/components/page-readiness"
import { TransferPopoverContent } from "./page-editor/components/transfer-popover-content"
import { SeoPanel } from "./page-editor/components/seo-panel"
import { PageHeaderMeta } from "./page-editor/components/page-header-meta"
import { SettingsPanel } from "./page-editor/components/settings-panel"
import { SlicesPanel } from "./page-editor/components/slices-panel"
import { ADMIN_HISTORY_BROWSER_BINDING } from "./contributions/history"
import { SnapshotHistoryPanelSlot } from "./page-editor/components/snapshot-history-panel"
import {
  usePageSave,
  sharedDraftValues,
  type DiscardDraft,
  type PublishPage,
  type RetainedPageSaveBase,
  type RetainedSharedPageSaveDraft,
  type SaveSnapshotEditorDraft,
  type UpdateDraft,
  type UpdatePage,
} from "./page-editor/hooks/use-page-save"
import { usePrePublishChecklist } from "./page-editor/hooks/use-pre-publish-checklist"
import {
  confirmCurrentPrePublishReadiness,
  usePrePublishReadinessCopy,
} from "./page-editor/lib/pre-publish-readiness"
import {
  getTitle,
  hasAnyContent,
  slugify,
  summarizeLocaleContent,
} from "./page-editor/lib/content"
import { checklistItemsKey } from "./page-editor/lib/checklist"
import {
  adoptLocaleBase,
  adoptRecoveryBase,
  bufferRecoveryBase,
  type Buffered,
  heldRecoveryBase,
  buildSessionBase,
  cloneBase,
  dropLocaleBase,
  localeBaseOf,
  restoreExpectations,
  type SnapshotEditorPublication,
} from "./page-editor/lib/publication-base"
import type { PageReadinessSuggestion } from "./page-editor/lib/readiness"
import {
  applyPageField,
  rebasePageField,
  hasStructuralSliceChange,
} from "./page-editor/lib/page-inline-draft"
import {
  extractLocalizedFieldValues,
  extractSharedFieldValues,
} from "./page-editor/lib/descriptor-values"
import {
  isPrimitiveValueEmpty,
  type Primitive,
} from "@/convex/lib/slices/primitives"
import {
  adminContentTypeCapabilities,
  adminContentTypeLocalizedFields,
  adminContentTypeSharedFields,
  adminContentTypes,
} from "@/lib/admin/content-types"
import { ContentTypeFieldsPanel } from "./content-type-fields-panel"
import {
  EditionPageWorkflow,
  useEditionPageWorkflow,
} from "@/components/edition/page-workflow"
import {
  ADMIN_AI_TRANSLATION_BROWSER_BINDING,
  type AdminAiTranslationHostResult,
  type AdminAiTranslationRouteData,
} from "./contributions/ai-translation"
import {
  ADMIN_AI_WRITING_BROWSER_BINDING,
  type AdminAiWritingPageEditorHostResult,
  type AdminAiWritingRouteData,
} from "./contributions/ai-writing"

/**
 * Permissive shape of a `content[locale]` bag as this editor reads it.
 *
 * The stored arm union widened when plan 029 C10 registered the pure-form
 * `testimonial` arm — its `content[locale]` is `{title, quote}` with no
 * `metaTitle` / `metaDescription` / `slices`. This editor is the
 * slice-body editor (plan 029 C10 task 13 will ship the testimonial
 * pure-form editor separately); reading through this shape lets absent
 * keys read as `undefined` without static-type refusal, and testimonial
 * pages that end up here render an empty slice canvas until the
 * pure-form editor lands.
 */
type SliceBodyLocaleReadBag =
  | {
      title?: string
      metaTitle?: string
      metaDescription?: string
      slices?: Slice[]
    }
  | undefined
const asSliceBodyLocaleBag = (value: unknown): SliceBodyLocaleReadBag =>
  value as SliceBodyLocaleReadBag

function currentTimestamp() {
  return Date.now()
}

function writeLocaleDraft(
  cache: { current: Record<string, LocaleDraft> },
  locale: Locale,
  draft: LocaleDraft
) {
  cache.current[locale] = draft
}

export type { SnapshotEditorPublication }

function PageEditorContributionCommands({
  commands,
}: {
  commands: AdminCommand[]
}) {
  useRegisterAdminCommands(commands)
  return null
}

// One shared empty list: a fresh `[]` every render would change the recovery
// effect's dependencies on every keystroke.
const NO_INLINE_CONFLICTS: PreviewInlineEditCommit[] = []

// Module-level so the component bodies hold no unsupported statements. React
// Compiler 1.0.0 silently skips a whole component that contains a `finally`, a
// `throw` inside `try`, or value blocks (optional chaining, `??`, ternaries)
// inside try/catch (react/react#34131, #35605, #35573); ESLint still passes
// (react/react#37789). The work still runs inside the try, so errors map as
// before. `page-editor/compiler-coverage.node.test.ts` guards the result.

async function tryAsync(
  run: () => Promise<void>,
  onError: (err: unknown) => void
): Promise<void> {
  try {
    await run()
  } catch (err) {
    onError(err)
  }
}

/** The value of `run`, or null when it throws. */
function attempt<T>(run: () => T): { value: T } | null {
  try {
    return { value: run() }
  } catch {
    return null
  }
}

/**
 * Delete the retained target-language draft. Module-level so the component
 * body has no `finally` clause: React Compiler 1.0.0 skips whole components
 * that contain one (react/react#34131). Same calls, same order, same toasts.
 */
async function runRetainedTargetDraftDeletion({
  deleteDraft,
  onDeleted,
  isCurrent,
  setDeleting,
  deletedMessage,
  failedMessage,
}: {
  deleteDraft: () => Promise<unknown>
  /** Runs once the server has deleted the draft, even if this editor moved on. */
  onDeleted: () => void
  isCurrent: () => boolean
  setDeleting: (deleting: boolean) => void
  deletedMessage: string
  failedMessage: string
}): Promise<void> {
  try {
    await deleteDraft()
    onDeleted()
    if (!isCurrent()) return
    toast.success(deletedMessage)
  } catch {
    if (!isCurrent()) return
    toast.error(failedMessage)
  } finally {
    if (isCurrent()) setDeleting(false)
  }
}

/**
 * Best-effort carry-over of descriptor-generic fields onto a recovered copy.
 * Module-level because it holds a `throw` inside `try` plus value blocks:
 * React Compiler 1.0.0 skips any component that contains them (react/react
 * #35605, #35573). Same calls, same order; every failure stays silent.
 */
async function carryOverRecoveredCopyFields({
  convex,
  newId,
  sliceBodyPageType,
  currentLocale,
  title,
  metaTitle,
  metaDescription,
  slices,
  sharedFieldValues,
  localizedFieldValues,
  presentationCatalog,
  updateDraft,
  saveEditorSnapshotDraft,
}: {
  convex: ReturnType<typeof useConvex>
  newId: Id<"pages">
  // `pageType` state narrowed by the caller (testimonial has no slice body).
  sliceBodyPageType: Exclude<PageEditorProps["page"]["pageType"], "testimonial">
  currentLocale: Locale
  title: string
  metaTitle: string
  metaDescription: string
  slices: Slice[]
  sharedFieldValues: Record<string, unknown>
  localizedFieldValues: Record<string, unknown>
  presentationCatalog: { revision: string } | null | undefined
  updateDraft: ReactMutation<typeof api.cms.pages.updateDraft>
  saveEditorSnapshotDraft: ReactMutation<
    typeof api.cms.publication.saveEditorDraft
  >
}): Promise<void> {
  try {
    const hasLocalizedFields = Object.keys(localizedFieldValues).length > 0
    const hasSharedFields = Object.keys(sharedFieldValues).length > 0
    if (hasLocalizedFields || hasSharedFields) {
      const updateDraftArgs: Record<string, unknown> = {
        pageId: newId,
        // Legacy fresh page → no staging OCC token yet; server treats absent
        // `expectedUpdatedAt` as lazy-create / no conflict.
      }
      if (hasLocalizedFields) {
        updateDraftArgs.content = {
          [currentLocale]: {
            pageType: sliceBodyPageType,
            localized: {
              title:
                title || getContentDefault(currentLocale, "recoveredDraft"),
              metaTitle: metaTitle || undefined,
              metaDescription: metaDescription || undefined,
              ...localizedFieldValues,
            },
            slices,
          },
        }
      }
      if (hasSharedFields) {
        updateDraftArgs.sharedFieldsJson = JSON.stringify(sharedFieldValues)
      }
      const copyDraftArgs = updateDraftArgs as Parameters<typeof updateDraft>[0]
      const target = await convex.query(api.cms.pages.getForEdit, {
        id: newId,
      })
      if (!target) throw new Error("Created page is unavailable")
      if (target.publication) {
        const targetPublication = target.publication
        const localizedDraft = copyDraftArgs.content?.[currentLocale]
        await saveEditorSnapshotDraft({
          pageId: newId,
          expectedLifecycleGeneration: targetPublication.lifecycleGeneration,
          ...(presentationCatalog
            ? {
                expectedPresentationCatalogRevision:
                  presentationCatalog.revision,
              }
            : {}),
          ...(hasSharedFields
            ? {
                shared: {
                  sharedFieldsJson: copyDraftArgs.sharedFieldsJson,
                  expectedGeneration: targetPublication.sharedDraftGeneration,
                },
              }
            : {}),
          ...(localizedDraft
            ? {
                localized: {
                  locale: currentLocale,
                  slug:
                    target.page.localizedSlugs?.[currentLocale] ??
                    target.page.slug,
                  draft: localizedDraft,
                  expectedGeneration:
                    targetPublication.locales.find(
                      (entry) => entry.locale === currentLocale
                    )?.draftGeneration ?? 0,
                },
              }
            : {}),
        })
      } else {
        await updateDraft(copyDraftArgs)
      }
    }
  } catch {
    // Descriptor-field carry-over failed — the recovered draft still
    // exists with title/meta/slices; the user can re-enter descriptor
    // fields there. Silent by design; no destructive fallback path.
  }
}

type PageEditorProps = {
  page: Page
  // ADR-0041 §Migration step 2 (item 1) — supplied by the editor page's
  // `pages.getForEdit` server read. Seeds the "Unpublished changes" badge
  // (via `hasStaging`) and the staging-row OCC token for the first
  // `updateDraft` call (undefined = lazy-create).
  hasStaging: boolean
  stagingUpdatedAt: number | undefined
  publication?: SnapshotEditorPublication
  aiWritingRouteData?: AdminAiWritingRouteData
  aiTranslationRouteData?: AdminAiTranslationRouteData
  archiveStateVerificationFailure?: boolean
  // F09b: the open language replacement's target, resolved by the route from
  // the server. Set only when the owner writes the new-language version; the
  // editor then saves through the target-draft commands and cannot publish.
  targetDraftLocale?: string
  // The open replacement's target in ordinary editing. Its draft is in
  // `page.content` too, so the editor never opens on it.
  replacementTargetLocale?: string
  // Validated against enabled locales by the server route.
  requestedLocale?: string
  routeDefaultLocale?: string
  // The site's languages as the server route read them, so the opening
  // language is right on the first render, before the client query answers.
  routeEnabledLocales?: readonly string[]
  // The home page id as the route read it, for the same first-render reason.
  routeHomePageId?: string
}

type RestoredEditorDraft = {
  pageId: Id<"pages">
  locale: string
  editorLocale?: string
  // The tab the remount opens, when it is not the tab open at reconciliation
  // (a Translation Accept opens its target language).
  requestedEditorLocale?: string
  removedTitleLinks?: TitleWriteReport[]
  retainedDrafts?: Record<string, LocaleDraft>
  restoreStartedAt?: number
  saveBase?: RetainedPageSaveBase
  sharedSaveBase?: RetainedPageSaveBase
  retainedSharedDraft?: RetainedSharedPageSaveDraft
  retainedHistoryBase?: { save: RetainedPageSaveBase }
  // The replaced tab's generation base, one entry per language it held.
  retainedPublicationBase?: SnapshotEditorPublication
} & (
  | { draftGeneration: number; sharedDraftGeneration: number }
  | { updatedAt: number }
)

export function PageEditor(props: PageEditorProps) {
  // The server's conversion diagnostics cannot be recovered from canonical
  // content. Hold them above the session until its refreshed draft arrives.
  const [restored, setRestored] = useState<RestoredEditorDraft | null>(null)
  const ready =
    restored &&
    restored.pageId === props.page._id &&
    ("draftGeneration" in restored
      ? props.publication &&
        props.publication.sharedDraftGeneration >=
          restored.sharedDraftGeneration &&
        props.publication.locales.some(
          (locale) =>
            locale.locale === restored.locale &&
            locale.draftGeneration >= restored.draftGeneration
        )
      : (props.stagingUpdatedAt ?? props.page.updatedAt) >= restored.updatedAt)
  const adopt = ready && restored.retainedDrafts !== undefined
  return (
    <PageEditorSession
      {...props}
      key={
        adopt
          ? "draftGeneration" in restored
            ? `history-${restored.draftGeneration}-${restored.sharedDraftGeneration}`
            : `history-revision-${restored.updatedAt}`
          : "initial"
      }
      initialEditorLocale={adopt ? restored.editorLocale : undefined}
      initialTitleReports={adopt ? restored.removedTitleLinks : undefined}
      retainedDrafts={adopt ? restored.retainedDrafts : undefined}
      retainedHistoryBase={adopt ? restored.retainedHistoryBase : undefined}
      retainedPublicationBase={
        adopt ? restored.retainedPublicationBase : undefined
      }
      restoredLocale={adopt ? restored.locale : undefined}
      retainedSharedDraft={adopt ? restored.retainedSharedDraft : undefined}
      pendingHistoryRestore={ready && !adopt ? restored : undefined}
      onHistoryRestored={setRestored}
    />
  )
}

function PageEditorSession({
  page,
  hasStaging: initialHasStaging,
  stagingUpdatedAt: initialStagingUpdatedAt,
  publication,
  aiWritingRouteData,
  aiTranslationRouteData,
  archiveStateVerificationFailure = false,
  targetDraftLocale,
  replacementTargetLocale,
  requestedLocale,
  routeDefaultLocale,
  routeEnabledLocales,
  routeHomePageId,
  initialEditorLocale,
  initialTitleReports,
  retainedDrafts,
  retainedHistoryBase,
  retainedPublicationBase,
  restoredLocale,
  retainedSharedDraft,
  onHistoryRestored,
  pendingHistoryRestore,
}: PageEditorProps & {
  initialEditorLocale?: string
  initialTitleReports?: TitleWriteReport[]
  retainedDrafts?: Record<string, LocaleDraft>
  retainedHistoryBase?: RestoredEditorDraft["retainedHistoryBase"]
  retainedPublicationBase?: RestoredEditorDraft["retainedPublicationBase"]
  restoredLocale?: string
  retainedSharedDraft?: RestoredEditorDraft["retainedSharedDraft"]
  pendingHistoryRestore?: RestoredEditorDraft
  onHistoryRestored(result: RestoredEditorDraft): void
}) {
  const router = useRouter()
  const confirm = useConfirm()
  const displayError = useCaughtError()
  const adminLocale = useLocale()
  const t = useTranslations("editor.page")
  const tPageSave = useTranslations("editor.pageSave")
  const tAuthorMember = useTranslations("pages.authorMember")
  const tLanguageChange = useTranslations("editor.page.languageChange")
  const readinessCopy = usePrePublishReadinessCopy()
  const tReadiness = useTranslations("editor.readiness")

  const siteConfig = useQuery(api.cms.settings.getSiteConfig)
  // F09 row 39: set only during a content-language replacement.
  const sourcePublicationNotice = useQuery(
    api.cms.language.getSourcePublicationNotice,
    publication ? { pageId: page._id } : "skip"
  )
  const retainedTargetRemedy = useQuery(
    api.cms.language.getRetainedTargetDraftRemedy,
    publication && !targetDraftLocale ? { pageId: page._id } : "skip"
  )
  const workflow = useEditionPageWorkflow(page._id)
  const enabledLocales = siteConfig?.enabledLocales ?? ["en"]
  const defaultLocale = siteConfig?.defaultLocale ?? routeDefaultLocale ?? "en"

  // Candidate parents for the page-settings selector. Excludes self and any
  // descendant of this page (walk up each candidate's `parentId` chain). The
  // server enforces the same constraint — this just hides invalid options.
  //
  // Read ONCE at mount, deliberately not a subscription. As `useQuery` this
  // held a live subscription whose read set was the whole `pages` table, so
  // every save re-executed it — re-reading up to 500 full page documents to
  // recompute a dropdown. Convex bills database I/O on each execution, and it
  // is the tightest free-plan limit. `listSummaries` also trims the payload
  // (egress), but not re-executing is the part that matters.
  //
  // Tradeoff: the list won't live-update if someone else adds a page while
  // this editor is open. Acceptable for a parent picker — the server
  // re-validates the hierarchy on save regardless.
  const convex = useConvex()
  const [allPages, setAllPages] = useState<PageSummaryRow[] | undefined>(
    undefined
  )
  useEffect(() => {
    let active = true
    void convex
      .query(api.cms.pages.listSummaries, {})
      .then((rows) => {
        if (active) setAllPages(rows)
      })
      .catch(() => {
        // A failed parent list must not break the editor; the selector just
        // shows "No parent" until reload.
        if (active) setAllPages([])
      })
    return () => {
      active = false
    }
  }, [convex])
  const parentOptions = (() => {
    if (!allPages) return []
    const parentOf = new Map(allPages.map((p) => [p._id, p.parentId]))
    const isDescendant = (id: string) => {
      let cursor: string | undefined =
        parentOf.get(id as Id<"pages">) ?? undefined
      const seen = new Set<string>()
      while (cursor && !seen.has(cursor)) {
        if (cursor === page._id) return true
        seen.add(cursor)
        cursor = parentOf.get(cursor as Id<"pages">) ?? undefined
      }
      return false
    }
    return allPages.filter(
      (p) =>
        p._id !== page._id &&
        p.status !== "archived" &&
        !isDescendant(p._id) &&
        // Plan 028 C5 — author pages mount flat under `/authors/` (C3
        // routing) and don't participate in the ancestry hierarchy, so
        // they can't be picked as parents nor take one.
        p.pageType !== "author" &&
        page.pageType !== "author"
    )
  })()

  // Locales that already have content (used for the "has content" indicator).
  const localesWithContent = enabledLocales.filter(
    (l) => page.content?.[l]?.title
  )
  // Explicit target draft > later history restore > URL request (except the
  // replacement target) > the interface language when it is a site language >
  // the site's default language. A request only seeds mount.
  const siteLocalesAtMount = siteConfig?.enabledLocales ?? routeEnabledLocales
  const [currentLocale, setCurrentLocale] = useState<Locale>(
    targetDraftLocale ??
      initialEditorLocale ??
      (requestedLocale !== replacementTargetLocale
        ? requestedLocale
        : undefined) ??
      (siteLocalesAtMount?.includes(adminLocale) &&
      adminLocale !== replacementTargetLocale
        ? adminLocale
        : defaultLocale)
  )
  // The checklist refuses a language that is not switched on yet.
  const { result: prePublishChecklistResult, retry: retryPrePublishChecklist } =
    usePrePublishChecklist(page._id, currentLocale, !targetDraftLocale)
  const prePublishChecklistError = prePublishChecklistResult instanceof Error
  const prePublishChecklist = prePublishChecklistError
    ? undefined
    : prePublishChecklistResult
  const publishReadinessUnavailable =
    !targetDraftLocale &&
    (prePublishChecklistError || prePublishChecklistResult === undefined)
  const publishReadinessDisabledReason = prePublishChecklistError
    ? tReadiness("publishWait")
    : tReadiness("checking")
  const activeLocaleRef = useRef<Locale>(currentLocale)

  const retainedLocaleDraft = retainedDrafts?.[currentLocale]
  const localeContent =
    retainedLocaleDraft ?? asSliceBodyLocaleBag(page.content?.[currentLocale])
  const [initialPageDraftHandoff] = useState(() =>
    readPageDraftHandoff(page._id)
  )

  // The slug a locale starts from in the editor:
  //  - an explicit per-locale override, if one was saved;
  //  - else the base slug for the default locale, when that locale has content
  //    (a page saved with an empty address, e.g. a non-Latin title created
  //    before the slug fallback, adopts the title's address so its first Save
  //    is not refused);
  //  - else (a locale with no address of its own yet, including a default
  //    language not translated yet) the slugified title, so each locale
  //    auto-generates its own slug (FR "mes produits" → /mes-produits)
  //    instead of inheriting the default-locale slug.
  function initialSlugFor(locale: Locale): string {
    const override = page.localizedSlugs?.[locale]
    if (override) return override
    if (locale === defaultLocale && !isUntranslatedDefault(locale)) {
      return page.slug || slugify(getTitle(page, locale))
    }
    return slugify(getTitle(page, locale))
  }
  // The base slug is the address in the language the page was written in (or
  // in the language that was the default when it was saved). When the default
  // language was switched afterwards, a language with no content of its own yet
  // does not own that address: it starts from its own title, so translating
  // into it never inherits (or overwrites) the other language's address.
  function isUntranslatedDefault(locale: Locale): boolean {
    // The home page's address is its own: it never adopts a title's.
    if ((siteConfig?.homePageId ?? routeHomePageId) === page._id) return false
    const content = page.content ?? {}
    if (getTitle(page, locale) || content[locale]) return false
    return Object.keys(content).length > 0
  }
  // Linked = the slug still tracks the slugified title (auto-generate on);
  // false once the user manually diverges.
  function isSlugLinked(locale: Locale, slugVal: string): boolean {
    // An empty slug tracks the title, as on a locale switch; otherwise a
    // new-language version with no title yet would save without a slug.
    if (!slugVal) return true
    const t = getTitle(page, locale)
    return !!t && slugify(t) === slugVal
  }

  // One draft authority across locale, field and inline activation changes.
  const draftRevisionRef = useRef(0)
  const [draftRevision, setDraftRevision] = useState(0)
  // Counts every write to a field of the draft, with no state: reading it never
  // renders. `advanceDraftRevision` also feeds a SlicesPanel prop, so it stays
  // limited to title and slice commits. Save compares this count to tell that a
  // pending capture was overtaken by typing React has not reflected in
  // `draftRef` yet.
  const draftWritesRef = useRef(0)
  function noteDraftWrite() {
    draftWritesRef.current += 1
  }
  function advanceDraftRevision() {
    noteDraftWrite()
    draftRevisionRef.current += 1
    setDraftRevision(draftRevisionRef.current)
  }
  // The remaining draft fields count their writes too (title and slices go
  // through `advanceDraftRevision`).
  function setSlug(value: SetStateAction<typeof slug>) {
    noteDraftWrite()
    setSlugState(value)
  }
  function setPageType(value: SetStateAction<typeof pageType>) {
    noteDraftWrite()
    setPageTypeState(value)
  }
  function setParentId(value: SetStateAction<typeof parentId>) {
    noteDraftWrite()
    setParentIdState(value)
  }
  function setAuthorIds(value: SetStateAction<typeof authorIds>) {
    noteDraftWrite()
    setAuthorIdsState(value)
  }
  function setTags(value: SetStateAction<typeof tags>) {
    noteDraftWrite()
    setTagsState(value)
  }
  function setMetaTitle(value: SetStateAction<typeof metaTitle>) {
    noteDraftWrite()
    setMetaTitleState(value)
  }
  function setMetaDescription(value: SetStateAction<typeof metaDescription>) {
    noteDraftWrite()
    setMetaDescriptionState(value)
  }
  function setSeoNoIndex(value: SetStateAction<typeof seoNoIndex>) {
    noteDraftWrite()
    setSeoNoIndexState(value)
  }
  function setSeoNoFollow(value: SetStateAction<typeof seoNoFollow>) {
    noteDraftWrite()
    setSeoNoFollowState(value)
  }
  function setSeoOgTitle(value: SetStateAction<typeof seoOgTitle>) {
    noteDraftWrite()
    setSeoOgTitleState(value)
  }
  function setSeoOgDescription(value: SetStateAction<typeof seoOgDescription>) {
    noteDraftWrite()
    setSeoOgDescriptionState(value)
  }
  function setSeoOgImage(value: SetStateAction<typeof seoOgImage>) {
    noteDraftWrite()
    setSeoOgImageState(value)
  }
  function setSharedFieldValues(
    value: SetStateAction<typeof sharedFieldValues>
  ) {
    noteDraftWrite()
    setSharedFieldValuesState(value)
  }
  function setLocalizedFieldValues(
    value: SetStateAction<typeof localizedFieldValues>
  ) {
    noteDraftWrite()
    setLocalizedFieldValuesState(value)
  }
  const [title, setTitleState] = useState(
    () => retainedLocaleDraft?.title ?? getTitle(page, currentLocale)
  )
  // Set when a Save was refused because the title is blank; it keeps the title
  // marked until a real title is typed or the editor loads another draft.
  const [titleSaveRefused, setTitleSaveRefused] = useState(false)
  const titleRequiredId = useId()
  // Whether the last refused Save was the blank-title refusal, read by the
  // dialog/popover callers that run a Save first (Duplicate, Copy from,
  // Translate from). `focusTitleOnCloseRef` asks the one that closes next to
  // hand focus to the title instead of back to its trigger.
  const titleRefusedRef = useRef(false)
  const focusTitleOnCloseRef = useRef(false)
  function setTitle(value: string) {
    advanceDraftRevision()
    setTitleState(value)
    if (value.trim() !== "") setTitleSaveRefused(false)
  }
  const [slug, setSlugState] = useState(
    () =>
      retainedLocaleDraft?.slug ??
      initialPageDraftHandoff?.slug ??
      initialSlugFor(currentLocale)
  )
  const [slugLinked, setSlugLinked] = useState(
    () =>
      retainedLocaleDraft?.slugLinked ??
      (initialPageDraftHandoff?.slug
        ? false
        : isSlugLinked(currentLocale, initialSlugFor(currentLocale)))
  )
  const [pageType, setPageTypeState] = useState(
    retainedSharedDraft?.values.pageType ?? page.pageType
  )
  // Per-locale *persisted* slug, so the slug field can distinguish a saved
  // localized override from one that's only auto-previewed from the title. The
  // `page` prop isn't refetched after save, so we keep this in sync ourselves
  // (mirroring the mutation's rule: a non-default slug equal to the base is
  // stored as "no override"). Default locale lives under `defaultLocale`.
  const [savedSlugByLocale, setSavedSlugByLocale] = useState<
    Record<string, string>
  >(() => {
    const map: Record<string, string> = {}
    if (page.slug) map[defaultLocale] = page.slug
    for (const [loc, s] of Object.entries(page.localizedSlugs ?? {})) {
      if (s) map[loc] = s
    }
    return map
  })
  // "" = no parent (root). Convex `parentId` is `v.optional(v.id("pages"))`,
  // so we send `undefined` to clear it on save.
  const [parentId, setParentIdState] = useState<string>(
    retainedSharedDraft?.values.parentId ?? page.parentId ?? ""
  )
  // Byline references for post pages. Post-arm-only field (plan 028 C1);
  // non-post pages start empty. Ordered — index 0 is the lead author by
  // convention (plan 029 C10 §Q6, task 14).
  const [authorIds, setAuthorIdsState] = useState<Id<"pages">[]>(
    retainedSharedDraft?.values.authorIds ??
      (page.pageType === "post"
        ? (page.authorIds ?? [])
            .map((a) => a.pageId)
            .filter((id): id is Id<"pages"> => id !== undefined)
        : [])
  )
  const [tags, setTagsState] = useState<string[]>(
    retainedSharedDraft?.values.tags ??
      (page.pageType === "post" ? (page.tags ?? []) : [])
  )
  const [metaTitle, setMetaTitleState] = useState(
    initialPageDraftHandoff?.metaTitle ?? localeContent?.metaTitle ?? ""
  )
  const [metaDescription, setMetaDescriptionState] = useState(
    initialPageDraftHandoff?.metaDescription ??
      localeContent?.metaDescription ??
      ""
  )
  const [initialTitleAdoption] = useState(() =>
    adoptHeroTitles(
      initialPageDraftHandoff?.slices ?? localeContent?.slices ?? [],
      currentLocale,
      mergeTitleReports(
        initialTitleReports ?? [],
        retainedLocaleDraft?.removedTitleLinks ?? []
      )
    )
  )
  const titleReports = useRef<TitleWriteReport[]>(initialTitleAdoption.reports)
  const [slices, setSlicesState] = useState<Slice[]>(initialTitleAdoption.value)
  const slicesRef = useRef(slices)
  const slicesEpochRef = useRef(0)
  const [slicesEpoch, setSlicesEpoch] = useState(0)
  function prepareIncomingDraft<
    T extends { slices: Slice[]; removedTitleLinks?: TitleWriteReport[] },
  >(draft: T, locale = currentLocale) {
    const prepared = prepareHeroTitleDraft(draft, locale, titleReports.current)
    return {
      ...prepared,
      structuralChange: hasStructuralSliceChange(
        slicesRef.current,
        prepared.slices
      ),
    }
  }
  // Commit only prepared values. Parsing, cloning, validation and structural
  // comparison all finish before any parent state/ref/cache is published.
  function commitPreparedSlices(
    prepared: {
      slices: Slice[]
      removedTitleLinks?: TitleWriteReport[]
      structuralChange: boolean
    },
    structural = true
  ) {
    titleReports.current = prepared.removedTitleLinks ?? []
    if (structural && prepared.structuralChange) {
      slicesEpochRef.current += 1
      setSlicesEpoch(slicesEpochRef.current)
    }
    // Keep the event-owned baseline ahead of queued React render snapshots.
    slicesRef.current = prepared.slices
    advanceDraftRevision()
    setSlicesState(prepared.slices)
  }
  const scheduleSidebarPublication = useRef<(() => void) | null>(null)
  const publishSidebarDraft = useEffectEvent(() => {
    // The frame owns session end; only the parent renderer can publish its
    // event-owned draft and flush the sidebar editor's adoption effects.
    flushSync(() => setSlicesState(slicesRef.current))
  })
  function scheduleSidebarPublicationIfFocused() {
    // Composition can settle after focus has already crossed to the sidebar.
    // Keep this value block outside try/catch for the installed compiler.
    if (document.activeElement?.closest("[data-preview-sidebar]")) {
      scheduleSidebarPublication.current?.()
    }
  }
  useEffect(() => {
    const root = document.body
    let live = true
    function schedulePublication() {
      queueMicrotask(() => {
        if (live) publishSidebarDraft()
      })
    }
    scheduleSidebarPublication.current = schedulePublication
    function onSidebarFocus(event: FocusEvent) {
      const target = event.target as Element | null
      if (!target?.closest?.("[data-preview-sidebar]")) return
      // Body capture follows the canvas's document capture. Focus can also
      // be restored during a React commit, so publish after that stack ends,
      // at the microtask checkpoint before the next native input task.
      schedulePublication()
    }
    root.addEventListener("focusin", onSidebarFocus, true)
    return () => {
      live = false
      scheduleSidebarPublication.current = null
      root.removeEventListener("focusin", onSidebarFocus, true)
    }
  }, [])
  function commitPreparedLocale(
    prepared: LocaleDraft & { structuralChange: boolean }
  ) {
    activeLocaleBufferRef.current = prepared
    setTitleSaveRefused(false)
    setTitle(prepared.title)
    setSlug(prepared.slug)
    setSlugLinked(prepared.slugLinked)
    setAddressWasTyped(prepared.addressWasTyped ?? false)
    setMetaTitle(prepared.metaTitle)
    setMetaDescription(prepared.metaDescription)
    commitPreparedSlices(prepared)
    setLocalizedFieldValues(prepared.localizedFieldValues)
  }
  // Sidebar, slice copy/translation and AI merge all prepare before publication.
  function setSlices(value: SetStateAction<Slice[]>, locale = currentLocale) {
    const prepared = prepareIncomingDraft(
      {
        slices: typeof value === "function" ? value(slicesRef.current) : value,
      },
      locale
    )
    commitPreparedSlices(prepared)
  }
  const activePreviewEditRef = useRef<PreviewActiveEditHandle | null>(null)
  const previewEditBufferRef = useRef<PreviewInlineEditCommit | null>(null)
  const [repeatedPreviewConflict, setRepeatedPreviewConflict] =
    useState<PreviewInlineEditCommit | null>(null)
  const repeatedPreviewConflictRef = useRef<PreviewInlineEditCommit | null>(
    null
  )
  // Descriptor-generic field bags (plan 029 C8). Populated once from the
  // stored doc + primitive defaults; the generic Content panel edits them,
  // save merges them into the descriptor-shaped `draft.localized` bag.
  // `sharedFieldValues` covers non-system-owned shared descriptor fields
  // (e.g. author `name`/`socials`); `localizedFieldValues` covers
  // non-system-owned localized fields (e.g. author `roleTitle`/`bio`).
  const [sharedFieldValues, setSharedFieldValuesState] = useState<
    Record<string, unknown>
  >(
    () =>
      retainedSharedDraft?.values.sharedFieldValues ??
      extractSharedFieldValues(
        page,
        adminContentTypeSharedFields(page.pageType)
      )
  )
  const [localizedFieldValues, setLocalizedFieldValuesState] = useState<
    Record<string, unknown>
  >(
    () =>
      retainedLocaleDraft?.localizedFieldValues ??
      extractLocalizedFieldValues(
        page,
        adminContentTypeLocalizedFields(page.pageType),
        currentLocale
      )
  )
  const [activePanel, setActivePanel] = useState<ActivePanel>("slices")
  const [seoFocusRequest, setSeoFocusRequest] = useState(0)
  const handledSeoFocusRequest = useRef(0)
  useEffect(() => {
    if (
      activePanel !== "seo" ||
      handledSeoFocusRequest.current === seoFocusRequest
    )
      return
    const input = document.getElementById("page-meta-title")
    if (input) {
      input.focus()
      handledSeoFocusRequest.current = seoFocusRequest
    }
  }, [seoFocusRequest, activePanel])
  const [slicePickerOpen, setSlicePickerOpen] = useState(false)
  const [selectedSliceId, setSelectedSliceId] = useState<string | null>(null)
  // Mirror of the preview mode. C keeps the sidebar mounted so full-profile
  // body content and unrendered fields remain reachable during inline editing.
  const [previewInlineEditingEnabled, setPreviewInlineEditingEnabled] =
    useState(false)
  const [focusedFieldTarget, setFocusedFieldTarget] =
    useState<SliceFieldFocusTarget | null>(null)
  const [focusedFirstControlTarget, setFocusedFirstControlTarget] =
    useState<SliceFirstControlFocusTarget | null>(null)
  const [previewInlineRefusal, setPreviewInlineRefusal] =
    useState<PreviewInlineRefusalReason | null>(null)

  // Page-global SEO fields (one set per page, not per-locale) — persisted on the
  // page's `seo` object via the `update` mutation.
  const [seoNoIndex, setSeoNoIndexState] = useState(
    retainedSharedDraft?.values.seoNoIndex ?? page.seo?.noIndex ?? false
  )
  const [seoNoFollow, setSeoNoFollowState] = useState(
    retainedSharedDraft?.values.seoNoFollow ?? page.seo?.noFollow ?? false
  )
  const [seoOgTitle, setSeoOgTitleState] = useState(
    retainedSharedDraft?.values.seoOgTitle ?? page.seo?.ogTitle ?? ""
  )
  const [seoOgDescription, setSeoOgDescriptionState] = useState(
    retainedSharedDraft?.values.seoOgDescription ??
      page.seo?.ogDescription ??
      ""
  )
  const [seoOgImage, setSeoOgImageState] = useState(
    retainedSharedDraft?.values.seoOgImage ?? page.seo?.ogImage ?? ""
  )
  const visiblePrePublishChecklist = (() => {
    if (!prePublishChecklist || prePublishChecklistError) return undefined

    // Plan 029 C9a — filter descriptor `missing_required_field` items whose
    // unsaved editor state already has content. The core-checked fields
    // (title/meta) have their own filter branch below; descriptor fields
    // use the same emptiness contract the server checklist used to emit
    // them (`isPrimitiveValueEmpty`).
    //
    // The field format is a top-level descriptor key ± leaf subpath:
    // - shared: `<fieldKey>` or `<fieldKey>[...][subpath]`
    // - localized: `content.<locale>.<fieldKey>[...]`
    const localizedFieldDefs = adminContentTypeLocalizedFields(page.pageType)
    const sharedFieldDefs = adminContentTypeSharedFields(page.pageType)
    const descriptorFieldContentPresent = (item: {
      code: string
      field?: string
    }): boolean => {
      if (item.code !== "missing_required_field") return true
      const field = item.field ?? ""
      // Plan 029 C9a — advisor-flagged bug: `isPrimitiveValueEmpty` on a
      // top-level group/list returns non-empty when ANY child is populated,
      // so a required nested leaf (e.g. `socials[0].url` empty while
      // `socials[0].platform` is filled) would have its blocker filtered
      // away and the Publish button falsely enable. Safe stance: only
      // filter TOP-LEVEL leaf blockers (path == fieldKey with no subpath).
      // Nested-leaf blockers pass through unchanged until the user saves;
      // conservative, honest to the server contract.
      const localizedMatch = field.match(/^content\.([^.]+)\.(.+)$/)
      const [locale, tail] = localizedMatch
        ? [localizedMatch[1], localizedMatch[2]]
        : [undefined, field]
      const hasSubpath = /[.[]/.test(tail)
      if (hasSubpath) return true
      const fieldKey = tail
      if (locale) {
        const def = (localizedFieldDefs as Record<string, Primitive>)[fieldKey]
        if (!def) return true
        const bag =
          locale === currentLocale
            ? localizedFieldValues
            : drafts.current[locale as Locale]?.localizedFieldValues
        return isPrimitiveValueEmpty(def, bag?.[fieldKey])
      }
      const def = (sharedFieldDefs as Record<string, Primitive>)[fieldKey]
      if (!def) return true
      return isPrimitiveValueEmpty(def, sharedFieldValues[fieldKey])
    }

    if (currentLocale !== defaultLocale) {
      const blockers = prePublishChecklist.blockers.filter(
        descriptorFieldContentPresent
      )
      const warnings = prePublishChecklist.warnings.filter(
        descriptorFieldContentPresent
      )
      return {
        ...prePublishChecklist,
        canPublish: blockers.length === 0,
        blockers,
        warnings,
      }
    }

    const titleIsPresent = title.trim().length > 0
    const seoTitleIsPresent =
      metaTitle.trim().length > 0 || !!page.seo?.metaTitle?.trim()
    const seoDescriptionIsPresent =
      metaDescription.trim().length > 0 || !!page.seo?.metaDescription?.trim()
    const hasContentSections = slices.length > 0
    const blockers = prePublishChecklist.blockers.filter((item) => {
      if (item.code === "missing_default_locale_title") return !titleIsPresent
      if (!descriptorFieldContentPresent(item)) return false
      return true
    })
    const warnings = prePublishChecklist.warnings.filter((item) => {
      if (item.code === "missing_default_locale_content") {
        return !hasContentSections
      }
      if (item.code === "missing_seo_title") return !seoTitleIsPresent
      if (item.code === "missing_seo_description") {
        return !seoDescriptionIsPresent
      }
      if (!descriptorFieldContentPresent(item)) return false
      return true
    })

    return {
      ...prePublishChecklist,
      canPublish: blockers.length === 0,
      blockers,
      warnings,
    }
  })()
  const prePublishWarningKey = visiblePrePublishChecklist
    ? checklistItemsKey(visiblePrePublishChecklist.warnings)
    : ""
  const [acknowledgedPrePublishWarnings, setAcknowledgedPrePublishWarnings] =
    useState<string | null>(null)
  const warningsAcknowledged =
    prePublishWarningKey.length > 0 &&
    acknowledgedPrePublishWarnings === prePublishWarningKey
  const hasPublishBlockers =
    (visiblePrePublishChecklist?.blockers.length ?? 0) > 0

  // In-memory per-locale edit cache so switching locales mid-edit (e.g. while
  // translating) doesn't discard unsaved title/meta/slice changes.
  const drafts = useRef<Record<string, LocaleDraft>>(retainedDrafts ?? {})
  const [draftSummaries, setDraftSummaries] = useState<
    Record<string, LocaleContentSummary>
  >({})

  // Published Snapshot history belongs to core Publication. Legacy draft
  // revisions still require the optional History (M06) participant.
  const HistoryPanelSlot = publication
    ? targetDraftLocale
      ? undefined
      : SnapshotHistoryPanelSlot
    : ADMIN_HISTORY_BROWSER_BINDING?.PanelSlot
  const historyInstalled = HistoryPanelSlot !== undefined
  const activeEditors = useQuery(api.cms.pages.listActiveEditors, {
    pageId: page._id,
  })
  const pageEditorLock = useQuery(api.cms.pages.getPageEditorLock, {
    pageId: page._id,
  })
  const [addressWasTyped, setAddressWasTyped] = useState(
    () => retainedLocaleDraft?.addressWasTyped ?? false
  )
  const addressMessages = usePageAddressMessages(defaultLocale)
  const addressAvailability = useQuery(
    api.cms.publication.addressAvailability,
    publication
      ? {
          pageId: page._id,
          locale: currentLocale,
          slug,
          parentId: parentId ? (parentId as Id<"pages">) : null,
          intent: slugLinked && !addressWasTyped ? "generated" : "typed",
        }
      : "skip"
  )
  const addressAllocation = addressAvailability?.entries.find(
    (entry) => entry.locale === currentLocale
  )?.allocation
  const allocatedLinked = Boolean(
    !addressWasTyped &&
    addressAllocation &&
    addressAllocation.wantedSlug === slugify(title) &&
    addressAllocation.allocatedSlug === slug
  )
  const createPage = useMutation(api.cms.pages.create)
  const presentationCatalog = useQuery(
    api.cms.slices.getPresentationCatalog,
    {}
  )
  // ADR-0041 §Migration step 2 (item 2) — editor writes go through the
  // staging seam (`updateDraft` / `publish` / `discardDraft`). The legacy
  // `pages.update` remains only for hierarchy moves, pageType changes,
  // `expiresAt`, and status transitions. (`scheduledAt` moved onto
  // staging in PR B — the cron reads `pageStaging.by_scheduledAt` and
  // publishes via the shared `performPublish` helper.)
  const updateDraft = useMutation(api.cms.pages.updateDraft)
  const publishPageMutation = useMutation(api.cms.pages.publish)
  const discardDraftMutation = useMutation(api.cms.pages.discardDraft)
  const updatePage = useMutation(api.cms.pages.update)
  const softDelete = useMutation(api.cms.pages.softDelete)
  const saveEditorSnapshotDraft = useMutation(
    api.cms.publication.saveEditorDraft
  )
  const saveTargetLocaleDraft = useMutation(api.cms.publication.saveLocaleDraft)
  const saveTargetSharedDraft = useMutation(api.cms.publication.saveSharedDraft)
  const publishSnapshotLocale = useMutation(api.cms.publication.publishLocale)
  const discardSnapshotLocaleDraft = useMutation(
    api.cms.publication.discardLocaleDraft
  )
  const withdrawSnapshotLocale = useMutation(api.cms.publication.withdrawLocale)
  const archiveSnapshotPage = useMutation(api.cms.publication.archivePage)
  const restoreSnapshotPage = useMutation(api.cms.publication.restorePage)
  const softDeleteSnapshotPage = useMutation(api.cms.publication.softDeletePage)
  const deleteRetainedTargetDraft = useMutation(
    api.cms.language.deleteRetainedTargetDraft
  )
  const [deletingRetainedTargetDraft, setDeletingRetainedTargetDraft] =
    useState(false)
  // One generation base per content buffer this tab holds, taken when each
  // buffer was loaded. `publication` is a server prop that a later
  // `router.refresh()` replaces without reloading any buffer, so it is read only
  // here (the mount payload), at the first visit to a language and at a History
  // remount; never copied over the base on every refresh.
  const [initialPublicationBase] = useState(() =>
    buildSessionBase(
      publication,
      retainedPublicationBase && restoredLocale !== undefined
        ? {
            base: retainedPublicationBase,
            restoredLocale,
            keepRestoredLocale: retainedHistoryBase !== undefined,
            keepShared: retainedSharedDraft !== undefined,
          }
        : undefined
    )
  )
  const publicationRef = useRef(initialPublicationBase)
  // Active content and its provenance are captured together. A cached copy
  // is never the authority for a locale that is currently being edited.
  const activeLocaleBufferRef = useRef<LocaleDraft>({
    title,
    slug,
    slugLinked,
    addressWasTyped,
    metaTitle,
    metaDescription,
    slices,
    localizedFieldValues,
    refusalBase: retainedLocaleDraft?.refusalBase,
  })
  const sharedBufferRef = useRef<
    Buffered<RetainedSharedPageSaveDraft["values"]>
  >({
    pageType,
    parentId,
    authorIds,
    tags,
    seoNoIndex,
    seoNoFollow,
    seoOgTitle,
    seoOgDescription,
    seoOgImage,
    sharedFieldValues,
    refusalBase: retainedSharedDraft?.refusalBase,
  })
  function sharedBuffer() {
    return {
      ...sharedBufferRef.current,
      pageType,
      parentId,
      authorIds,
      tags,
      seoNoIndex,
      seoNoFollow,
      seoOgTitle,
      seoOgDescription,
      seoOgImage,
      sharedFieldValues,
    }
  }
  function localeRefusal(locale: string) {
    return (
      locale === currentLocale
        ? activeLocaleBufferRef.current
        : drafts.current[locale]
    )?.refusalBase
  }
  function recoveryBaseForLocale(locale: string) {
    return bufferRecoveryBase(
      heldRecoveryBase(publicationRef.current, locale),
      localeRefusal(locale),
      hasUnsavedSharedDraft(sharedBuffer())
        ? sharedBufferRef.current.refusalBase
        : undefined
    )
  }

  const heartbeatPageEditor = useMutation(api.cms.pages.heartbeatPageEditor)
  const leavePagePresence = useMutation(api.cms.pages.leavePagePresence)
  const acquirePageEditorLock = useMutation(api.cms.pages.acquirePageEditorLock)
  const releasePageEditorLock = useMutation(api.cms.pages.releasePageEditorLock)
  // Renew the editor lock right before a staged write. The heartbeat below
  // deliberately pauses while the tab is hidden, so a user returning after
  // more than PAGE_LOCK_ACTIVE_MS can beat the visibilitychange heartbeat to
  // the Save button and hit the hard lock gate in `updateDraft`. Beating here
  // closes that race at the point the lock is actually checked.
  //
  // `false` = another editor holds it (heartbeat never forces), which is a
  // real conflict the take-over UI already handles — not a stale-lock error.
  async function refreshEditorLock(): Promise<boolean> {
    try {
      const result = await heartbeatPageEditor({ pageId: page._id })
      return result.status === "acquired"
    } catch {
      // Network/permission failures surface from the save mutation itself
      // with a better message; don't pre-empt it with a lock error.
      return true
    }
  }

  // Under snapshot authority this tab must hold a base. A tab opened before a
  // legacy-to-snapshot cutover has none, and the refreshed `publication` prop is
  // never a base for content it did not load, so the write is refused through
  // the existing stale-save path (recovery copy kept, Reload loads fresh).
  function snapshotBase() {
    const base = publicationRef.current
    if (!base && publication) throw new Error(staleSaveMessage)
    return base
  }

  function draftSaveBase(patch: Parameters<SaveSnapshotEditorDraft>[0]) {
    const base = snapshotBase()
    if (!base) return undefined
    const locale = patch.localized?.locale ?? currentLocale
    const localized = patch.localized ? localeRefusal(locale) : undefined
    const shared = patch.shared
      ? sharedBufferRef.current.refusalBase
      : undefined
    const refusal = bufferRecoveryBase(
      heldRecoveryBase(base, locale),
      localized,
      shared
    )
    return localized || shared
      ? adoptRecoveryBase(base, locale, refusal ?? undefined)
      : base
  }

  function currentPublicationLocale(locale = currentLocale) {
    const state = publicationRef.current
    if (!state) return undefined
    return localeBaseOf(state, locale)
  }

  // F09b: `saveEditorDraft` accepts only the current language, so the
  // new-language version saves through the two commands that accept it. They
  // are separate transactions: if the shared half fails after the language
  // half saved, the owner sees the error and a retry resaves both.
  const persistTargetDraft: SaveSnapshotEditorDraft = async (patch) => {
    const publicationState = draftSaveBase(patch)!
    if (patch.localized) {
      const localeState = localeBaseOf(publicationState, patch.localized.locale)
      const result = await saveTargetLocaleDraft({
        pageId: page._id,
        locale: patch.localized.locale,
        slug: patch.localized.slug,
        draft: patch.localized.draft,
        expectedDraftGeneration: localeState.draftGeneration,
        expectedLifecycleGeneration: publicationState.lifecycleGeneration,
        ...(patch.expectedPresentationCatalogRevision
          ? {
              expectedPresentationCatalogRevision:
                patch.expectedPresentationCatalogRevision,
            }
          : {}),
      })
      localeState.draftGeneration = result.generation
      if (
        !publicationState.locales.some(
          (entry) => entry.locale === localeState.locale
        )
      ) {
        publicationState.locales.push(localeState)
      }
    }
    if (patch.shared) {
      const result = await saveTargetSharedDraft({
        pageId: page._id,
        ...patch.shared,
        expectedSharedDraftGeneration: publicationState.sharedDraftGeneration,
        expectedLifecycleGeneration: publicationState.lifecycleGeneration,
      })
      publicationState.sharedDraftGeneration = result.generation
    }
    return { updatedAt: currentTimestamp() }
  }

  const persistSnapshotEditorDraft: SaveSnapshotEditorDraft = async (patch) => {
    if (targetDraftLocale) return persistTargetDraft(patch)
    const publicationState = draftSaveBase(patch)!
    const localeState = patch.localized
      ? localeBaseOf(publicationState, patch.localized.locale)
      : undefined
    const result = await saveEditorSnapshotDraft({
      pageId: page._id,
      expectedLifecycleGeneration: publicationState.lifecycleGeneration,
      ...(patch.expectedPresentationCatalogRevision
        ? {
            expectedPresentationCatalogRevision:
              patch.expectedPresentationCatalogRevision,
          }
        : {}),
      ...(patch.shared
        ? {
            shared: {
              ...patch.shared,
              expectedGeneration: publicationState.sharedDraftGeneration,
            },
          }
        : {}),
      ...(patch.localized && localeState
        ? {
            localized: {
              ...patch.localized,
              expectedGeneration: localeState.draftGeneration,
            },
          }
        : {}),
    })
    if (localeState && result.draftGeneration !== undefined) {
      localeState.draftGeneration = result.draftGeneration
      if (
        !publicationState.locales.some(
          (entry) => entry.locale === localeState.locale
        )
      ) {
        publicationState.locales.push(localeState)
      }
    }
    if (result.sharedDraftGeneration !== undefined) {
      publicationState.sharedDraftGeneration = result.sharedDraftGeneration
    }
    return {
      updatedAt: result.updatedAt,
      ...(result.slug ? { slug: result.slug } : {}),
    }
  }

  const editorUpdateDraft: UpdateDraft = async (args) => {
    const publicationState = snapshotBase()
    if (!publicationState) return updateDraft(args)
    if (args.scheduledAt !== undefined) {
      throw new Error(
        "Scheduled publication is not available under snapshot authority yet"
      )
    }
    const sharedChanged =
      args.sharedFieldsJson !== undefined ||
      args.seo !== undefined ||
      args.authorIds !== undefined ||
      args.tags !== undefined
    const localizedInput = args.content?.[currentLocale]
    const localizedChanged =
      localizedInput !== undefined ||
      args.slug !== undefined ||
      args.localizedSlugs !== undefined
    const fallbackLocalized = {
      ...localizedFieldValues,
      title,
      ...(hasSliceBody(page)
        ? {
            metaTitle: metaTitle || undefined,
            metaDescription: metaDescription || undefined,
          }
        : {}),
    }
    const addressResult = await persistSnapshotEditorDraft({
      ...(args.expectedPresentationCatalogRevision
        ? {
            expectedPresentationCatalogRevision:
              args.expectedPresentationCatalogRevision,
          }
        : {}),
      ...(sharedChanged
        ? {
            shared: {
              sharedFieldsJson: args.sharedFieldsJson,
              seo: args.seo,
              authorIds: args.authorIds,
              tags: args.tags,
            },
          }
        : {}),
      ...(localizedChanged
        ? {
            localized: {
              locale: currentLocale,
              addressIntent: "generated",
              slug:
                currentLocale === defaultLocale
                  ? (args.slug ?? slug).trim()
                  : (args.localizedSlugs?.[currentLocale] ?? slug).trim(),
              draft: (localizedInput ??
                (hasSliceBody(page)
                  ? {
                      pageType: page.pageType,
                      localized: fallbackLocalized,
                      slices,
                    }
                  : {
                      pageType: page.pageType,
                      localized: fallbackLocalized,
                    })) as never,
            },
          }
        : {}),
    })
    if (addressResult.slug && addressResult.slug !== slug) {
      setSlug(addressResult.slug)
      setAddressWasTyped(false)
    }
    return { updatedAt: addressResult.updatedAt }
  }

  const editorPublishPage: PublishPage = async (args) => {
    const publicationState = snapshotBase()
    if (!publicationState) return publishPageMutation(args)
    const localeState = currentPublicationLocale()!
    const result = await publishSnapshotLocale({
      pageId: page._id,
      locale: currentLocale,
      expectedDraftGeneration: localeState.draftGeneration,
      expectedSharedDraftGeneration: publicationState.sharedDraftGeneration,
      expectedPublicGeneration: localeState.publicGeneration,
      expectedLifecycleGeneration: publicationState.lifecycleGeneration,
      expectedReleaseGeneration: localeState.releaseGeneration,
    })
    localeState.publicGeneration = result.publicGeneration
    localeState.releaseGeneration += 1
    localeState.currentSnapshotId = result.snapshotId
    return { updatedAt: result.publishedAt }
  }

  const editorDiscardDraft: DiscardDraft = async (args) => {
    const publicationState = snapshotBase()
    if (!publicationState) return discardDraftMutation(args)
    const localeState = currentPublicationLocale()!
    const result = await discardSnapshotLocaleDraft({
      pageId: page._id,
      locale: currentLocale,
      expectedDraftGeneration: localeState.draftGeneration,
      expectedLifecycleGeneration: publicationState.lifecycleGeneration,
    })
    localeState.draftGeneration = result.generation
    return null
  }

  const editorUpdatePage: UpdatePage = async (args) => {
    const publicationState = snapshotBase()
    if (!publicationState) return updatePage(args)
    if (args.pageType !== undefined || args.expiresAt !== undefined) {
      throw new Error(
        "Page type and expiry changes are not available under snapshot authority yet"
      )
    }
    if (args.parentId !== undefined || args.clearParent) {
      await persistSnapshotEditorDraft({
        shared: {
          parentId: args.parentId,
          clearParent: args.clearParent,
        },
      })
    }
    if (args.status === "draft") {
      if (page.status === "archived") {
        const result = await restoreSnapshotPage({
          pageId: page._id,
          expectedLifecycleGeneration: publicationState.lifecycleGeneration,
        })
        publicationState.lifecycleGeneration = result.lifecycleGeneration
      } else {
        const localeState = currentPublicationLocale()!
        if (!localeState.currentSnapshotId) {
          return { updatedAt: currentTimestamp() }
        }
        await withdrawSnapshotLocale({
          pageId: page._id,
          locale: currentLocale,
          expectedSnapshotId: localeState.currentSnapshotId,
          expectedPublicGeneration: localeState.publicGeneration,
          expectedLifecycleGeneration: publicationState.lifecycleGeneration,
        })
        localeState.publicGeneration += 1
        localeState.currentSnapshotId = undefined
      }
    } else if (args.status === "archived") {
      const result = await archiveSnapshotPage({
        pageId: page._id,
        expectedLifecycleGeneration: publicationState.lifecycleGeneration,
      })
      publicationState.lifecycleGeneration = result.lifecycleGeneration
    }
    return {
      updatedAt: currentTimestamp(),
      staged: args.parentId !== undefined || args.clearParent === true,
    }
  }

  const {
    hasUnsaved,
    isSaving,
    savedAt,
    hasStaging,
    recoveryDraft,
    recoveryRefused,
    refuseForRecovery,
    setRecoveryDraft,
    clearRecoveryDraftState,
    discardRecoveryDraft,
    rememberUpdatedAt,
    captureEditorScope,
    isEditorPageMounted,
    hasUnsavedLocaleDraft,
    captureSaveBase,
    captureSharedDraft,
    hasUnsavedSharedDraft,
    save: handleSave,
    ensureSaved,
    publish: handlePublish,
    discard: handleDiscard,
    unpublish: handleUnpublish,
    archive: handleArchive,
    unarchive: handleUnarchive,
  } = usePageSave({
    page,
    getRecoveryBase: recoveryBaseForLocale,
    getSharedRefusalBase: () => sharedBufferRef.current.refusalBase,
    retainedSaveBase: retainedHistoryBase?.save,
    retainedSharedDraft,
    getDraftWriteCount: () => draftWritesRef.current,
    defaultLocale,
    currentLocale,
    initialPageDraftHandoff,
    draft: {
      title,
      slug,
      slugLinked,
      addressWasTyped,
      pageType,
      parentId,
      authorIds,
      tags,
      metaTitle,
      metaDescription,
      slices,
      inlineConflicts: repeatedPreviewConflict
        ? [repeatedPreviewConflict]
        : NO_INLINE_CONFLICTS,
      seoNoIndex,
      seoNoFollow,
      seoOgTitle,
      seoOgDescription,
      seoOgImage,
      sharedFieldValues,
      localizedFieldValues,
    },
    hasStaging: initialHasStaging,
    recoveryDraftForFlush(draft) {
      return {
        ...draft,
        ...prepareHeroTitleDraft(
          { ...draft, slices: slicesRef.current },
          currentLocale,
          titleReports.current
        ),
        inlineConflicts: repeatedPreviewConflictRef.current
          ? [repeatedPreviewConflictRef.current]
          : [],
      }
    },
    onPreparedDraft(draft) {
      // usePageSave has already prepared/validated this exact draft. Compute
      // comparisons before committing; never adopt it for a second time here.
      const slicesChanged =
        JSON.stringify(slicesRef.current) !== JSON.stringify(draft.slices)
      const sharedChanged =
        JSON.stringify(sharedFieldValues) !==
        JSON.stringify(draft.sharedFieldValues)
      const localizedChanged =
        JSON.stringify(localizedFieldValues) !==
        JSON.stringify(draft.localizedFieldValues)
      const prepared = {
        ...draft,
        removedTitleLinks: mergeTitleReports(
          titleReports.current,
          draft.removedTitleLinks ?? []
        ),
        structuralChange: false,
      }
      titleReports.current = prepared.removedTitleLinks
      if (slicesChanged) commitPreparedSlices(prepared, false)
      if (sharedChanged) setSharedFieldValues(prepared.sharedFieldValues)
      if (localizedChanged)
        setLocalizedFieldValues(prepared.localizedFieldValues)
    },
    captureDraft(draft) {
      const handle = activePreviewEditRef.current
      handle?.flush?.()
      if (handle?.isComposing()) {
        toast.error(tPageSave("finishTextInput"))
        return null
      }
      if (repeatedPreviewConflictRef.current) {
        toast.error(t("sliceChanged"))
        return null
      }
      return {
        ...draft,
        ...prepareHeroTitleDraft(
          { ...draft, slices: slicesRef.current },
          currentLocale,
          titleReports.current
        ),
      }
    },
    refuseDraft(draft, { snapshot, addressCleared }) {
      // Runs only for a localized write (title, content or address), so a
      // clean page, or a shared-field-only edit, on a locale whose saved title
      // is blank still saves, publishes and transfers. Every caller is a user
      // action, so the toast and focus never fire from a background tick.
      if (draft.title.trim() === "") {
        toast.error(tPageSave("titleRequired"))
        titleRefusedRef.current = true
        setTitleSaveRefused(true)
        queueMicrotask(() => document.getElementById("page-title")?.focus())
        return true
      }
      // Legacy path: clearing a non-default locale's address is legitimate
      // (it deletes the override and reuses the default-locale address); the
      // snapshot server needs one, and so does a default-locale address that
      // was emptied (a blank one is otherwise ignored and the page keeps its
      // old address while the field shows nothing).
      titleRefusedRef.current = false
      if ((snapshot || addressCleared) && draft.slug.trim() === "") {
        toast.error(tPageSave("slugRequired"))
        return true
      }
      return false
    },
    stagingUpdatedAt: initialStagingUpdatedAt,
    presentationCatalogRevision: presentationCatalog?.revision,
    updateDraft: editorUpdateDraft,
    saveSnapshotDraft: publication ? persistSnapshotEditorDraft : undefined,
    addressIntent: () =>
      (slugLinked || allocatedLinked) && !addressWasTyped
        ? "generated"
        : "typed",
    onAddressAllocated: (allocated, wanted) => {
      if (slug === wanted) {
        setSlug(allocated)
        setAddressWasTyped(false)
      }
    },
    refuseAddress: () => {
      if (
        !addressAvailability ||
        (!addressAvailability.parentChanged &&
          (slugLinked || allocatedLinked) &&
          !addressWasTyped)
      )
        return false
      const refused = addressAvailability.entries.some(
        (entry) => entry.changed && entry.check.kind !== "free"
      )
      if (refused)
        toast.error(addressMessages.refusal(addressAvailability.parentChanged))
      return refused
    },
    publishPage: editorPublishPage,
    discardDraft: editorDiscardDraft,
    updatePage: editorUpdatePage,
    refreshEditorLock,
    setSavedSlugByLocale,
    confirmPrePublishReadiness,
    confirmDiscard,
    onSaveConflict: handleSaveConflict,
    router,
  })
  const owner = useQuery(api.cms.owner.getOwnerSession)
  const canGenerate = owner !== undefined && owner !== null
  const titleMissing = titleSaveRefused && title.trim() === ""
  // Open state is mirrored in refs so an async refusal can tell whether the
  // popover/dialog is still open, and opening one clears any stale
  // "focus the title on close" request.
  const [copyOpen, setCopyOpenState] = useState(false)
  const copyOpenRef = useRef(false)
  function setCopyOpen(open: boolean) {
    copyOpenRef.current = open
    if (open) focusTitleOnCloseRef.current = false
    setCopyOpenState(open)
  }
  const [duplicateOpen, setDuplicateOpenState] = useState(false)
  const duplicateOpenRef = useRef(false)
  function setDuplicateOpen(open: boolean) {
    duplicateOpenRef.current = open
    if (open) focusTitleOnCloseRef.current = false
    setDuplicateOpenState(open)
  }
  // The server refuses to duplicate a page under snapshot authority.
  const canDuplicate = page.pageType !== "author" && !publication
  const tList = useTranslations("pages.list")
  const [unpublishAsk, setUnpublishAsk] = useState<UnpublishRequest | null>(
    null
  )
  // Ask the same question as the Pages list before anything is written.
  function requestUnpublish() {
    const isHome = (siteConfig?.homePageId ?? routeHomePageId) === page._id
    // A missing state reads as the header does: published when it has a snapshot.
    const locales = (publication?.locales ?? []).map((entry) => ({
      ...entry,
      state: entry.state ?? (entry.currentSnapshotId ? "published" : "draft"),
    }))
    const entry = locales.find((item) => item.locale === currentLocale)
    // Snapshot authority, language not published: nothing to ask about; the
    // action behaves as before this question existed.
    if (publication && entry?.state !== "published") {
      void handleUnpublish()
      return
    }
    // Snapshot authority: the address this language is published at.
    const path = publication
      ? entry?.path
      : isHome
        ? "/"
        : canonicalPathForPage(page, null, currentLocale, defaultLocale)
    setUnpublishAsk(
      unpublishRequest(tList, adminLocale, {
        locale: currentLocale,
        path,
        defaultLocale,
        languages: siteLocaleOrder(enabledLocales, defaultLocale),
        locales,
        isHome,
      })
    )
  }
  const [showPushOut, setShowPushOut] = useState(false)
  // Push direction (translate the current locale INTO another): switch the
  // editor to the target first, then run the pull from the stashed source. The
  // ref + effect avoid reading a stale `currentLocale` from a closure captured
  // before the switch lands.
  const pendingTransfer = useRef<{
    source: Locale
    mode: TranslateMode
    runPushedTranslate?: (
      source: Locale,
      target: Locale
    ) => void | Promise<void>
  } | null>(null)

  // When locale switches, stash the current locale's in-progress edits, then
  // load the target locale from its cached draft (if any) or the saved page.
  function handleLocaleChange(locale: Locale) {
    if (locale === currentLocale) return
    if (repeatedPreviewConflictRef.current) {
      toast.error(t("sliceChanged"))
      return
    }
    const handle = activePreviewEditRef.current
    handle?.flush?.()
    if (handle?.isComposing()) {
      toast.error(tPageSave("finishTextInput"))
      return
    }
    const capturedSlices = slicesRef.current
    const currentDraft = {
      ...activeLocaleBufferRef.current,
      title,
      slug,
      slugLinked,
      addressWasTyped,
      metaTitle,
      metaDescription,
      slices: capturedSlices,
      removedTitleLinks: titleReports.current,
      localizedFieldValues,
    }
    const draft = drafts.current[locale]
    const c = asSliceBodyLocaleBag(page.content?.[locale])
    const nextTitle = draft?.title ?? c?.title ?? ""
    const nextSlug = draft?.slug ?? initialSlugFor(locale)
    const attempted = attempt(() => {
      const prepared = prepareIncomingDraft(
        {
          refusalBase: draft?.refusalBase,
          title: nextTitle,
          slug: nextSlug,
          slugLinked:
            draft?.slugLinked ?? (!nextSlug || slugify(nextTitle) === nextSlug),
          addressWasTyped: draft?.addressWasTyped ?? false,
          metaTitle: draft?.metaTitle ?? c?.metaTitle ?? "",
          metaDescription: draft?.metaDescription ?? c?.metaDescription ?? "",
          slices: draft?.slices ?? c?.slices ?? [],
          removedTitleLinks: draft?.removedTitleLinks,
          localizedFieldValues:
            draft?.localizedFieldValues ??
            extractLocalizedFieldValues(
              page,
              adminContentTypeLocalizedFields(page.pageType),
              locale
            ),
        },
        locale
      )
      const currentSummary = summarizeLocaleContent(
        currentDraft,
        adminContentTypeLocalizedFields(page.pageType)
      )
      return { prepared, currentSummary }
    })
    if (!attempted) return false
    const { prepared, currentSummary } = attempted.value
    // Capture before the old text document is torn down. Keep a pending
    // recovery choice intact; otherwise persist this locale's latest buffer.
    if (
      !recoveryDraft &&
      (hasUnsaved || JSON.stringify(capturedSlices) !== JSON.stringify(slices))
    ) {
      const recoveryContent = { ...currentDraft }
      delete recoveryContent.refusalBase
      writeCapturedRecoveryDraft(page._id, {
        base: recoveryBaseForLocale(currentLocale),
        locale: currentLocale,
        ...recoveryContent,
        pageType,
        parentId,
        authorIds,
        tags,
        seoNoIndex,
        seoNoFollow,
        seoOgTitle,
        seoOgDescription,
        seoOgImage,
        sharedFieldValues,
      })
    }
    activePreviewEditRef.current = null
    handlePreviewActiveEditChange(null)
    drafts.current[currentLocale] = currentDraft
    // First visit: this language's content comes from the current `page` prop,
    // so its base comes from the same payload. A revisit keeps its stored base.
    if (!draft && publication && publicationRef.current)
      adoptLocaleBase(publicationRef.current, publication, locale)
    setDraftSummaries((prev) => ({ ...prev, [currentLocale]: currentSummary }))
    commitPreparedLocale(prepared)
    setSelectedSliceId(null)
    setFocusedFieldTarget(null)
    activeLocaleRef.current = locale
    setDeletingRetainedTargetDraft(false)
    setCurrentLocale(locale)
    const url = new URL(window.location.href)
    url.searchParams.set("locale", locale)
    window.history.replaceState(null, "", url)
    return true
  }

  const languageChangeNotice = languageChangeEditorNotice(
    sourcePublicationNotice,
    targetDraftLocale !== undefined,
    tLanguageChange
  )

  const otherLocales = enabledLocales.filter((l) => l !== currentLocale)

  // Per-field translation pulls from one default source locale: the default
  // locale when it isn't the one being edited, else the first other *enabled*
  // locale. Deliberately not gated on that locale having content — when it's
  // empty the per-field button shows disabled (consistent affordance) rather
  // than disappearing. Explicit multi-source choice stays in the page menu.
  const fieldSource: Locale | undefined =
    otherLocales.length === 0
      ? undefined
      : otherLocales.includes(defaultLocale)
        ? defaultLocale
        : otherLocales[0]

  // The source locale's saved slices/title for per-field pulls. Uses saved
  // content (not the `drafts` ref, which can't be read during render); an
  // unsaved edit to a *non-active* source locale is a rare edge we don't chase.
  const fieldSourceBag = fieldSource
    ? asSliceBodyLocaleBag(page.content?.[fieldSource])
    : undefined
  const fieldSourceSlices: Slice[] = fieldSourceBag?.slices ?? []
  const fieldSourceTitle: string = fieldSource
    ? getTitle(page, fieldSource)
    : ""
  const fieldSourceMetaTitle: string = fieldSourceBag?.metaTitle ?? ""
  const fieldSourceMetaDescription: string =
    fieldSourceBag?.metaDescription ?? ""

  function getSavedLocaleSummary(locale: Locale): LocaleContentSummary {
    const saved = asSliceBodyLocaleBag(page.content?.[locale])
    return summarizeLocaleContent(
      {
        title: saved?.title,
        metaTitle: saved?.metaTitle,
        metaDescription: saved?.metaDescription,
        slices: saved?.slices,
        // Plan 029 C9a — descriptor localized fields (author roleTitle/bio,
        // future faq/testimonial) count towards hasAny/hasTranslatable so
        // the transfer popover doesn't lie about empty locales that in
        // fact carry descriptor content.
        localizedFieldValues: extractLocalizedFieldValues(
          page,
          adminContentTypeLocalizedFields(page.pageType),
          locale
        ),
      },
      adminContentTypeLocalizedFields(page.pageType)
    )
  }

  function getRenderLocaleSummary(locale: Locale): LocaleContentSummary {
    if (locale === currentLocale) {
      return summarizeLocaleContent(
        {
          title,
          metaTitle,
          metaDescription,
          slices,
          localizedFieldValues,
        },
        adminContentTypeLocalizedFields(page.pageType)
      )
    }
    return draftSummaries[locale] ?? getSavedLocaleSummary(locale)
  }

  function hasContentForModeInRender(
    locale: Locale,
    mode: TranslateMode
  ): boolean {
    const summary = getRenderLocaleSummary(locale)
    return mode === "copy" ? summary.hasAny : summary.hasTranslatable
  }

  function getLocaleEditorContentForTransfer(locale: Locale) {
    const liveDraft: LocaleDraft | undefined =
      locale === currentLocale
        ? {
            ...activeLocaleBufferRef.current,
            title,
            slug,
            slugLinked,
            addressWasTyped,
            metaTitle,
            metaDescription,
            slices,
            localizedFieldValues,
          }
        : undefined
    const draft = liveDraft ?? drafts.current[locale]
    const saved = asSliceBodyLocaleBag(page.content?.[locale])

    return {
      draft,
      saved,
      title: draft?.title ?? saved?.title ?? "",
      metaTitle: draft?.metaTitle ?? saved?.metaTitle ?? "",
      metaDescription: draft?.metaDescription ?? saved?.metaDescription ?? "",
      slices: draft?.slices ?? saved?.slices ?? [],
    }
  }

  function hasAnyTransferContentForTransfer(locale: Locale): boolean {
    const c = getLocaleEditorContentForTransfer(locale)
    // Plan 029 C9a — descriptor localized fields feed into the transfer
    // popover's "has content" indicator via `summarizeLocaleContent`, so
    // an author with only roleTitle/bio filled in doesn't look empty.
    const draftLocalizedValues =
      c.draft?.localizedFieldValues ??
      extractLocalizedFieldValues(
        page,
        adminContentTypeLocalizedFields(page.pageType),
        locale
      )
    const summary = summarizeLocaleContent(
      {
        title: c.title,
        metaTitle: c.metaTitle,
        metaDescription: c.metaDescription,
        slices: c.slices,
        localizedFieldValues: draftLocalizedValues,
      },
      adminContentTypeLocalizedFields(page.pageType)
    )
    return summary.hasAny
  }

  function localeDraftDiffersFromSaved(locale: Locale): boolean {
    const c = getLocaleEditorContentForTransfer(locale)
    if (!c.draft) return false
    return (
      c.draft.title !== (c.saved?.title ?? "") ||
      c.draft.metaTitle !== (c.saved?.metaTitle ?? "") ||
      c.draft.metaDescription !== (c.saved?.metaDescription ?? "") ||
      JSON.stringify(c.draft.slices) !== JSON.stringify(c.saved?.slices ?? [])
    )
  }

  function localeWouldBeReplaced(locale: Locale): boolean {
    return (
      hasAnyTransferContentForTransfer(locale) ||
      localeDraftDiffersFromSaved(locale) ||
      (locale === currentLocale && hasUnsaved)
    )
  }

  const currentSummary = getRenderLocaleSummary(currentLocale)
  const currentHasContent = currentSummary.hasAny
  const canCopyContent =
    otherLocales.some((loc) => getRenderLocaleSummary(loc).hasAny) ||
    (currentHasContent && otherLocales.length > 0)

  // Copy another locale's content into the editor for the active locale, so an
  // empty locale can be seeded for translation. Client-only: the user reviews
  // and Saves to persist (no clobber until then). Slice ids are regenerated so
  // each locale owns independent instances.
  function handleCopyFrom(source: Locale) {
    const draft = drafts.current[source]
    const saved = asSliceBodyLocaleBag(page.content?.[source])
    const srcTitle = draft?.title ?? saved?.title ?? ""
    const srcSlices = draft?.slices ?? saved?.slices ?? []
    const cloned = srcSlices.map((s) =>
      Object.assign(
        {},
        structuredClone(s),
        writeSliceFields(s, source, { duplicate: true, identitiesOnly: true })
          .value,
        { id: crypto.randomUUID() }
      )
    )
    const sourceReports = mergeTitleReports(
      titleReports.current,
      draft?.removedTitleLinks ?? []
    )
    const removedTitleLinks = sourceReports.flatMap((report) => {
      const index = srcSlices.findIndex(
        (slice) => readSlice(slice).id === report.sliceId
      )
      return report.locale === source && index >= 0
        ? [
            {
              ...report,
              locale: currentLocale,
              sliceId: readSlice(cloned[index]).id,
            },
          ]
        : []
    })
    const attempted = attempt(() =>
      prepareIncomingDraft({
        refusalBase:
          draft?.refusalBase ?? activeLocaleBufferRef.current.refusalBase,
        title: srcTitle,
        slug: slugify(srcTitle),
        slugLinked: true,
        addressWasTyped: false,
        metaTitle: draft?.metaTitle ?? saved?.metaTitle ?? "",
        metaDescription: draft?.metaDescription ?? saved?.metaDescription ?? "",
        slices: cloned,
        removedTitleLinks,
        localizedFieldValues: structuredClone(
          draft?.localizedFieldValues ??
            extractLocalizedFieldValues(
              page,
              adminContentTypeLocalizedFields(page.pageType),
              source
            )
        ),
      })
    )
    if (!attempted) return
    const prepared = attempted.value
    commitPreparedLocale(prepared)
    toast.success(t("copiedContent", { locale: source.toUpperCase() }))
  }

  function confirmPrePublishReadiness(): Promise<boolean> {
    return confirmCurrentPrePublishReadiness({
      convex,
      pageId: page._id,
      locale: currentLocale,
      languageWarning: sourcePublicationWarning(
        sourcePublicationNotice,
        tLanguageChange
      ),
      confirm,
      acknowledgedWarningKey: acknowledgedPrePublishWarnings,
      acknowledgeWarnings: setAcknowledgedPrePublishWarnings,
      itemMessage: readinessCopy.itemMessage,
      copy: readinessCopy.copy,
    })
  }

  // ADR-0041 §9 — Discard confirmation. Owner rule (plain language):
  // the copy must reflect the ACTUAL outcome.
  //
  // After Deploy 2 PR B item 3, new drafts + duplicates seed staging on
  // top of an empty `pages.content`. Discarding a never-published draft
  // therefore drops the ONLY copy of its content — the confirmation
  // says so plainly. A published page still has its last-published
  // snapshot on `pages.content`, so its discard just reverts.
  async function confirmDiscard(
    kind: "published" | "never-published"
  ): Promise<boolean> {
    if (kind === "never-published") {
      return confirm({
        title: t("discard.neverPublishedTitle"),
        description: t("discard.neverPublishedDescription"),
        confirmText: t("discard.deleteDraft"),
        cancelText: t("discard.keepEditing"),
      })
    }
    return confirm({
      title: t("discard.title"),
      description: t("discard.description"),
      confirmText: t("discard.action"),
      cancelText: t("discard.keepEditing"),
    })
  }

  async function handleDeleteRetainedTargetDraft() {
    if (!retainedTargetRemedy) return
    const isCurrent = captureEditorScope()
    const locale = getLocaleDisplayName(retainedTargetRemedy.locale)
    const ok = await confirm({
      title: t("retainedTargetRemedy.confirmTitle", { locale }),
      description: t("retainedTargetRemedy.confirmDescription", { locale }),
      confirmText: t("retainedTargetRemedy.action", { locale }),
      cancelText: t("retainedTargetRemedy.keep"),
      destructive: true,
    })
    if (!ok || !isCurrent()) return
    setDeletingRetainedTargetDraft(true)
    await runRetainedTargetDraftDeletion({
      deleteDraft: () => deleteRetainedTargetDraft(retainedTargetRemedy),
      onDeleted: () => {
        // The draft is gone on the server, so a cached buffer and its base are
        // both obsolete. The returned generation is not stored beneath content
        // that was not reloaded; the next load of this language adopts from a
        // payload.
        const deletedLocale = retainedTargetRemedy.locale
        delete drafts.current[deletedLocale]
        if (publicationRef.current)
          dropLocaleBase(publicationRef.current, deletedLocale)
      },
      isCurrent,
      setDeleting: setDeletingRetainedTargetDraft,
      deletedMessage: t("retainedTargetRemedy.deleted", { locale }),
      failedMessage: t("retainedTargetRemedy.failed"),
    })
  }

  async function applyRecoveryDraft(draft: PageEditorRecoveryDraft) {
    if (
      !enabledLocales.includes(draft.locale) ||
      !isCurrentSourceRecovery(draft, page.pageType, currentLocale)
    ) {
      toast.error(t("recovery.incompatible"))
      return
    }
    let recovered
    try {
      recovered = prepareIncomingDraft(draft, draft.locale)
    } catch {
      // Leave the explicit recovery choice and original buffer available.
      // No parent state changes or writes occur until adoption succeeds.
      return
    }
    // Legacy authority keeps its ordinary recovery behavior.
    let refusalBase = activeLocaleBufferRef.current.refusalBase
    const held = publicationRef.current
    if (
      held &&
      !isRecoveryBaseCurrent(draft.base, recoveryBaseForLocale(draft.locale))
    )
      refusalBase =
        heldRecoveryBase(
          adoptRecoveryBase(held, draft.locale, parseRecoveryBase(draft.base)),
          draft.locale
        ) ?? undefined
    activeLocaleBufferRef.current = {
      title: draft.title,
      slug: draft.slug,
      slugLinked: draft.slugLinked ?? false,
      addressWasTyped: draft.addressWasTyped ?? false,
      metaTitle: draft.metaTitle,
      metaDescription: draft.metaDescription,
      slices: recovered.slices,
      removedTitleLinks: recovered.removedTitleLinks,
      localizedFieldValues: draft.localizedFieldValues ?? {},
      refusalBase,
    }
    sharedBufferRef.current = {
      ...sharedDraftValues(draft),
      refusalBase:
        refusalBase && hasUnsavedSharedDraft(draft)
          ? refusalBase
          : sharedBufferRef.current.refusalBase,
    }
    activeLocaleRef.current = draft.locale
    setCurrentLocale(draft.locale)
    setTitleSaveRefused(false)
    setTitle(draft.title)
    setSlug(draft.slug)
    setSlugLinked(draft.slugLinked ?? false)
    setAddressWasTyped(draft.addressWasTyped ?? false)
    setPageType(draft.pageType)
    setParentId(draft.parentId)
    setAuthorIds(draft.authorIds ?? [])
    setTags(draft.tags)
    setMetaTitle(draft.metaTitle)
    setMetaDescription(draft.metaDescription)
    commitPreparedSlices(recovered)
    setSeoNoIndex(draft.seoNoIndex)
    setSeoNoFollow(draft.seoNoFollow)
    setSeoOgTitle(draft.seoOgTitle)
    setSeoOgDescription(draft.seoOgDescription)
    setSeoOgImage(draft.seoOgImage)
    // Plan 029 C8 — descriptor-generic bags participate in recovery.
    // v1 payloads are refused by `readRecoveryDraft` so if we're here,
    // the bags are guaranteed present.
    setSharedFieldValues(draft.sharedFieldValues ?? {})
    setLocalizedFieldValues(draft.localizedFieldValues ?? {})
    handlePreviewActiveEditChange(null)
    setRecoveryDraft(null)
    toast.success(t("recovery.restored"))
  }

  async function saveConflictDraftCopy(isCurrent: () => boolean) {
    if (page.pageType === "author") {
      toast.error(tAuthorMember("conflictCopyUnavailable"))
      return
    }
    // Pure-form arms (`sliceBody: false`) aren't editable in this canvas
    // — plan 029 C10 task 13 ships a dedicated pure-form editor for
    // testimonial. Save-conflict recovery from THIS editor is only
    // meaningful for slice-body arms, and the mutation's draft-input
    // union has no `slices` field on the pure-form arm anyway. Bail with
    // a toast so the recovery flow surfaces the state to the editor.
    if (!hasSliceBody(page)) {
      toast.error(t("recovery.copyUnavailable"))
      return
    }
    const recoveredSlug = `${slug || slugify(title) || "page"}-recovered-${currentTimestamp()}`
    const seo: Record<string, unknown> = { ...(page.seo ?? {}) }
    const setOrDel = (k: string, v: unknown) => {
      if (v) seo[k] = v
      else delete seo[k]
    }
    setOrDel("noIndex", seoNoIndex)
    setOrDel("noFollow", seoNoFollow)
    setOrDel("ogTitle", seoOgTitle.trim())
    setOrDel("ogDescription", seoOgDescription.trim())
    setOrDel("ogImage", seoOgImage.trim())
    const newId = await createPage({
      ...(presentationCatalog
        ? { expectedPresentationCatalogRevision: presentationCatalog.revision }
        : {}),
      slug: recoveredSlug,
      pageType,
      status: "draft",
      title: title || getContentDefault(currentLocale, "recoveredDraft"),
      content: {
        [currentLocale]: {
          title: title || getContentDefault(currentLocale, "recoveredDraft"),
          metaTitle: metaTitle || undefined,
          metaDescription: metaDescription || undefined,
          slices,
        },
      },
      ...(pageType === "post" ? { tags } : {}),
      seo,
    })
    // Plan 029 C8 + ADR-0041 §Migration step 2 — createPage's
    // `localizedContentInput` only accepts the system-owned title/meta/
    // slices bag today (C10 widens it). Follow the create with a single
    // draft write so the recovered copy carries descriptor-generic
    // localized fields (author roleTitle/bio) and non-owned shared
    // descriptor values (author name/socials, post category) into the
    // fresh page's draft. Resolve the copy's authority and tokens rather
    // than using the editor's page-scoped writer. Best-effort: failures
    // don't invalidate the created copy.
    await carryOverRecoveredCopyFields({
      convex,
      newId,
      // `pageType` state was seeded from `page.pageType`; we've already
      // guarded on `hasSliceBody(page)` above, so re-narrowing the state
      // reflection here is safe and drops testimonial from the union so
      // the `contentDraftInputValidator` arm resolves.
      sliceBodyPageType: pageType as Exclude<typeof pageType, "testimonial">,
      currentLocale,
      title,
      metaTitle,
      metaDescription,
      slices,
      sharedFieldValues,
      localizedFieldValues,
      presentationCatalog,
      updateDraft,
      saveEditorSnapshotDraft,
    })
    if (!isCurrent()) return
    clearRecoveryDraftState()
    toast.success(t("recovery.savedAsNewPage"))
    router.push(`/admin/pages/${newId}`)
  }

  async function handleSaveConflict() {
    const isCurrent = captureEditorScope()
    const saveCopy = await confirm({
      title: t("conflict.title"),
      description: t("conflict.description"),
      confirmText: t("conflict.saveAsNew"),
      cancelText: t("cancel"),
    })
    if (saveCopy && isCurrent()) {
      await saveConflictDraftCopy(isCurrent)
    }
  }

  function handleRevisionRestored(
    updatedAt: number,
    removedTitleLinks: TitleWriteReport[] = []
  ) {
    titleReports.current = mergeTitleReports(
      titleReports.current,
      removedTitleLinks
    )
    if (!publication) {
      onHistoryRestored({
        pageId: page._id,
        updatedAt,
        locale: currentLocale,
        removedTitleLinks: titleReports.current,
        sharedSaveBase: captureSaveBase(currentLocale),
      })
    }
    rememberUpdatedAt(updatedAt)
    clearRecoveryDraftState()
    router.refresh()
  }

  // Called by the History panel at click time, before its confirmation, so a
  // restore is checked against what this tab loaded and saved, not against a
  // refreshed prop that carries another tab's write.
  function readSnapshotRestore() {
    const base = publicationRef.current
    return base ? restoreExpectations(base, currentLocale) : undefined
  }

  function captureRestoreReconciliation() {
    // Module-level clock: eslint's react-hooks/purity rejects a direct
    // `Date.now` here; it runs only from the History panel's click handler.
    const restoreStartedAt = currentTimestamp()
    const submittedLocale = currentLocale
    const isCurrent = captureEditorScope()
    return (result: HistoryRestoreResult) => {
      if (isCurrent() || !isEditorPageMounted()) return
      const locale = publication
        ? (result.locale ?? submittedLocale)
        : submittedLocale
      onHistoryRestored({
        pageId: page._id,
        locale,
        ...(publication && "draftGeneration" in result
          ? {
              draftGeneration: result.draftGeneration,
              sharedDraftGeneration: result.sharedDraftGeneration,
            }
          : { updatedAt: result.updatedAt }),
        removedTitleLinks: result.removedTitleLinks,
        restoreStartedAt,
        saveBase: captureSaveBase(locale),
      })
      router.refresh()
    }
  }

  useEffect(() => {
    if (!pendingHistoryRestore) return
    // Refresh can finish after more typing or another locale switch. Capture
    // here, immediately before the keyed remount, rather than at mutation end.
    const retained = { ...drafts.current }
    retained[currentLocale] = {
      ...activeLocaleBufferRef.current,
      title,
      slug,
      slugLinked,
      addressWasTyped,
      metaTitle,
      metaDescription,
      slices: slicesRef.current,
      removedTitleLinks: titleReports.current,
      localizedFieldValues,
    }
    const locale = pendingHistoryRestore.locale
    const keepSubmittedDraft = Boolean(
      pendingHistoryRestore.saveBase &&
      (locale === currentLocale
        ? hasUnsaved
        : retained[locale] && hasUnsavedLocaleDraft(locale, retained[locale]))
    )
    if (!keepSubmittedDraft) {
      delete retained[locale]
      if (pendingHistoryRestore.restoreStartedAt !== undefined) {
        const recovery = readRecoveryDraft(page._id, locale)
        if (
          !recovery ||
          recovery.savedAt <= pendingHistoryRestore.restoreStartedAt
        )
          clearRecoveryDraft(page._id, locale)
      }
    }
    const shared = captureSharedDraft(
      pendingHistoryRestore.sharedSaveBase ??
        pendingHistoryRestore.saveBase ??
        captureSaveBase(currentLocale)
    )
    const editorLocale =
      pendingHistoryRestore.requestedEditorLocale ?? currentLocale
    if (editorLocale !== currentLocale) {
      const url = new URL(window.location.href)
      url.searchParams.set("locale", editorLocale)
      window.history.replaceState(null, "", url)
    }
    onHistoryRestored({
      ...pendingHistoryRestore,
      retainedSharedDraft: shared || undefined,
      editorLocale,
      retainedDrafts: retained,
      // Every retained language keeps the base it was loaded from. The refresh
      // that ends the restore carries newer generations that no retained buffer
      // has loaded.
      retainedPublicationBase: cloneBase(publicationRef.current),
      retainedHistoryBase: keepSubmittedDraft
        ? { save: pendingHistoryRestore.saveBase! }
        : undefined,
      removedTitleLinks:
        keepSubmittedDraft && locale === currentLocale
          ? retained[locale].removedTitleLinks
          : pendingHistoryRestore.removedTitleLinks,
    })
  }, [
    pendingHistoryRestore,
    onHistoryRestored,
    currentLocale,
    title,
    slug,
    slugLinked,
    addressWasTyped,
    metaTitle,
    metaDescription,
    localizedFieldValues,
    hasUnsaved,
    hasUnsavedLocaleDraft,
    captureSharedDraft,
    captureSaveBase,
    page._id,
  ])

  async function handleAcquireEditorLock(force = false) {
    const isCurrent = captureEditorScope()
    if (
      force &&
      !(await confirm({
        title: t("focus.takeOverTitle"),
        description: t("focus.takeOverDescription"),
        confirmText: t("focus.takeOver"),
        cancelText: t("cancel"),
      }))
    ) {
      return
    }

    if (!isCurrent()) return
    await tryAsync(
      async () => {
        const result = await acquirePageEditorLock({ pageId: page._id, force })
        if (!isCurrent()) return
        if (result.status === "blocked") {
          const label =
            result.lock.name ?? result.lock.email ?? t("focus.anotherEditor")
          toast.message(t("focus.hasFocus", { label }))
        } else if (force) {
          toast.success(t("focus.takenOver"))
        } else {
          toast.success(t("focus.claimed"))
        }
      },
      (err) => {
        if (!isCurrent()) return
        toast.error(displayError(err, t("focus.updateFailed")))
      }
    )
  }

  async function handleReleaseEditorLock() {
    const isCurrent = captureEditorScope()
    try {
      await releasePageEditorLock({ pageId: page._id })
      if (!isCurrent()) return
      toast.success(t("focus.released"))
    } catch (err) {
      if (!isCurrent()) return
      toast.error(displayError(err, t("focus.releaseFailed")))
    }
  }

  async function confirmReplacementIfNeeded(source: Locale, target: Locale) {
    if (!localeWouldBeReplaced(target)) return true
    return confirm({
      title: t("transfer.replaceTitle", { locale: target.toUpperCase() }),
      description: t("transfer.replaceDescription", {
        target: target.toUpperCase(),
        source: source.toUpperCase(),
      }),
      confirmText: t("transfer.replaceAction"),
      cancelText: t("cancel"),
      destructive: true,
    })
  }

  async function prepareParticipantTransfer(source: Locale, target: Locale) {
    const isCurrent = captureEditorScope()
    titleRefusedRef.current = false
    if (!(await confirmReplacementIfNeeded(source, target)) || !isCurrent())
      return false
    const saved = await ensureSaved()
    return isCurrent() && saved
  }

  // Close-autofocus handler for the Duplicate dialog and Copy-from popover:
  // after a blank-title refusal, focus goes to the title, not the trigger.
  function focusTitleOnCloseAutoFocus(event: Event) {
    if (!focusTitleOnCloseRef.current) return
    focusTitleOnCloseRef.current = false
    event.preventDefault()
    document.getElementById("page-title")?.focus()
  }

  // After a blank-title refusal: if the dialog/popover is still open, let its
  // close hand focus to the title; if it already closed (focus moved into a
  // confirm first), nothing is left to intercept, so focus the title now and
  // leave no request behind for the next unrelated close.
  function returnToTitle(stillOpen: boolean) {
    if (stillOpen) focusTitleOnCloseRef.current = true
    else queueMicrotask(() => document.getElementById("page-title")?.focus())
  }

  async function saveBeforeDuplicate() {
    titleRefusedRef.current = false
    const saved = await ensureSaved()
    if (!saved && titleRefusedRef.current) {
      returnToTitle(duplicateOpenRef.current)
      setDuplicateOpen(false)
    }
    return saved
  }

  function reopenTransfer(
    mode: TranslateMode,
    translation: AdminAiTranslationHostResult | null
  ) {
    if (mode === "copy") setCopyOpen(true)
    else translation?.setTranslateOpen(true)
  }

  function closeTransfer(
    mode: TranslateMode,
    translation: AdminAiTranslationHostResult | null
  ) {
    if (mode === "copy") setCopyOpen(false)
    else translation?.setTranslateOpen(false)
  }

  async function prepareTransfer(
    source: Locale,
    target: Locale,
    mode: TranslateMode,
    translation: AdminAiTranslationHostResult | null
  ) {
    if (mode === "translate" && !translation) return false
    const isCurrent = captureEditorScope()
    if (!(await prepareParticipantTransfer(source, target))) {
      if (!isCurrent()) return false
      if (titleRefusedRef.current) {
        // The refusal already told the owner what to fix and put the cursor in
        // the title; reopening the popover would trap focus away from it.
        returnToTitle(mode === "copy" && copyOpenRef.current)
        closeTransfer(mode, translation)
      } else reopenTransfer(mode, translation)
      return false
    }
    return isCurrent()
  }

  async function handlePullCopy(source: Locale) {
    const isCurrent = captureEditorScope()
    if (
      !(await prepareTransfer(source, currentLocale, "copy", null)) ||
      !isCurrent()
    )
      return
    handleCopyFrom(source)
    closeTransfer("copy", null)
  }

  // Push: send the *current* locale's content into `target`. Save first (this
  // persists the source we're about to transfer), switch the editor to `target`,
  // then the effect below runs the pull/copy from the stashed source once
  // `currentLocale` actually equals `target`.
  async function handlePush(
    target: Locale,
    mode: TranslateMode,
    translation: AdminAiTranslationHostResult | null
  ) {
    const isCurrent = captureEditorScope()
    if (target === currentLocale) return
    if (mode === "translate" && !translation) return
    const sourceSummary = summarizeLocaleContent(
      {
        title,
        metaTitle,
        metaDescription,
        slices,
        localizedFieldValues,
      },
      adminContentTypeLocalizedFields(page.pageType)
    )
    const sourceHasContent =
      mode === "copy" ? sourceSummary.hasAny : sourceSummary.hasTranslatable
    if (!sourceHasContent) {
      toast.error(
        mode === "copy"
          ? t("transfer.noContentToCopy", {
              locale: currentLocale.toUpperCase(),
            })
          : t("transfer.noContentToTranslate", {
              locale: currentLocale.toUpperCase(),
            })
      )
      return
    }
    if (
      !(await prepareTransfer(currentLocale, target, mode, translation)) ||
      !isCurrent()
    )
      return
    if (!handleLocaleChange(target)) return
    pendingTransfer.current = {
      source: currentLocale,
      mode,
      ...(translation
        ? { runPushedTranslate: translation.runPushedTranslate }
        : {}),
    }
    closeTransfer(mode, translation)
  }

  const copyFromRef = useRef(handleCopyFrom)

  useEffect(() => {
    copyFromRef.current = handleCopyFrom
  })

  useEffect(() => {
    if (initialPageDraftHandoff) clearPageDraftHandoff(page._id)
  }, [initialPageDraftHandoff, page._id])

  useEffect(() => {
    const pending = pendingTransfer.current
    if (!pending) return
    pendingTransfer.current = null
    if (pending.mode === "copy") {
      queueMicrotask(() => copyFromRef.current(pending.source))
    } else if (pending.runPushedTranslate) {
      void pending.runPushedTranslate(pending.source, currentLocale)
    }
    // Runs after `handleLocaleChange` commits the switch; `currentLocale` is now
    // the push target. Intentionally keyed on currentLocale only.
  }, [currentLocale])

  function handleTitleChange(val: string) {
    setTitle(val)
    if (slugLinked || allocatedLinked) {
      setAddressWasTyped(false)
      setSlugLinked(true)
      setSlug(slugify(val))
    }
  }

  function handleSlugChange(val: string) {
    setAddressWasTyped(val.trim() !== "")
    const normalized = val.toLowerCase().replace(/\s+/g, "-")
    setSlug(normalized)
    // Clearing the field re-links to the title (auto-generate resumes);
    // any other manual value diverges from it.
    setSlugLinked(normalized === "" || slugify(title) === normalized)
  }

  // Presence + lock heartbeat.
  //
  // Cost note: every beat reads the whole page document server-side to
  // permission-check, and a page carries all slice bodies for all locales.
  // Convex bills database I/O, which is the tightest free-plan limit — so this
  // beats half as often as it used to, does it in ONE mutation instead of two,
  // and stops entirely while the tab is hidden. A backgrounded editor left open
  // overnight now costs nothing.
  //
  // 30s is safe against the server TTLs: presence expires at 45s
  // (PAGE_PRESENCE_ACTIVE_MS) and the lock at 90s (PAGE_LOCK_ACTIVE_MS), so a
  // visible tab always refreshes with slack. A hidden tab may lapse — that is
  // the intent: an unattended tab should not hold the lock — and the
  // visibilitychange listener beats immediately on return, so coming back to
  // the tab re-establishes presence without waiting for the next interval.
  useEffect(() => {
    let active = true
    const beat = () => {
      if (!active) return
      if (document.visibilityState !== "visible") return
      void heartbeatPageEditor({ pageId: page._id }).catch(() => {
        // Presence/lock should never interrupt editing; permission and auth
        // errors surface through the real save/publish actions.
      })
    }

    beat()
    const interval = window.setInterval(beat, 30_000)
    document.addEventListener("visibilitychange", beat)
    return () => {
      active = false
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", beat)
      void leavePagePresence({ pageId: page._id }).catch(() => {})
      void releasePageEditorLock({ pageId: page._id }).catch(() => {})
    }
  }, [heartbeatPageEditor, leavePagePresence, page._id, releasePageEditorLock])

  function openPreview() {
    // The saved preview refuses a language that is not switched on yet.
    if (targetDraftLocale) {
      toast.message(
        t("previewAfterLanguageSwitch", {
          locale: getLocaleDisplayName(targetDraftLocale),
        })
      )
      return
    }
    const canonical = canonicalPathForPage(
      page,
      siteConfig?.homePageId ?? null,
      currentLocale,
      defaultLocale
    )
    const target = toPublicPath(canonical, currentLocale, defaultLocale)
    const query = new URLSearchParams({
      path: target,
      pageId: page._id,
      locale: currentLocale,
    })
    // noopener makes a named target behave as _blank (MDN). Reuse the
    // preview window, then detach it from this same-origin editor.
    const preview = window.open(
      `/api/preview?${query.toString()}`,
      "formulacms-page-preview"
    )
    if (preview) preview.opener = null
  }

  async function handlePageReadinessAction(
    suggestion: PageReadinessSuggestion,
    generateMeta: (() => Promise<void>) | undefined
  ) {
    const switchToSuggestionLocale = (fallback?: Locale) => {
      const locale = (suggestion.locale as Locale | undefined) ?? fallback
      if (
        locale &&
        locale !== currentLocale &&
        enabledLocales.includes(locale)
      ) {
        handleLocaleChange(locale)
      }
    }

    switch (suggestion.id) {
      case "focus-title":
        switchToSuggestionLocale(defaultLocale)
        queueMicrotask(() => document.getElementById("page-title")?.focus())
        break
      case "add-content":
        switchToSuggestionLocale(defaultLocale)
        setActivePanel("slices")
        setSlicePickerOpen(true)
        break
      case "open-content":
        switchToSuggestionLocale()
        setActivePanel("slices")
        break
      case "open-seo":
        switchToSuggestionLocale(defaultLocale)
        setActivePanel("seo")
        setSeoFocusRequest((request) => request + 1)
        break
      case "generate-meta":
        if (!generateMeta) break
        switchToSuggestionLocale(defaultLocale)
        setActivePanel("seo")
        await generateMeta()
        break
      case "review-locale":
        if (enabledLocales.includes(suggestion.locale as Locale)) {
          handleLocaleChange(suggestion.locale as Locale)
        }
        setActivePanel("slices")
        break
    }
  }

  async function handleDelete() {
    const isCurrent = captureEditorScope()
    const ok = await confirm({
      title: t("trash.title"),
      description: t("trash.description"),
      confirmText: t("trash.action"),
      destructive: true,
    })
    if (!ok || !isCurrent()) return
    try {
      const publicationState = snapshotBase()
      if (publicationState) {
        const result = await softDeleteSnapshotPage({
          pageId: page._id,
          expectedLifecycleGeneration: publicationState.lifecycleGeneration,
        })
        publicationState.lifecycleGeneration = result.lifecycleGeneration
      } else {
        await softDelete({ id: page._id })
      }
      if (!isCurrent()) return
      toast.success(t("trash.moved"))
      router.push("/admin/pages")
    } catch (err) {
      if (!isCurrent()) return
      toast.error(
        destructiveRefusalMessage(err, t("trash.failed"), {
          PAGE_HOME_LIFECYCLE_REFUSED: t("trash.homeRefused"),
          PAGE_SOFT_DELETE_MENU_REFERENCE: t("trash.menuReference"),
          PAGE_SOFT_DELETE_PUBLISHED_POST_REFERENCE: t(
            "trash.publishedPostReference"
          ),
        })
      )
    }
  }

  const commandActionsRef = useRef({
    save: handleSave,
    publish: handlePublish,
    unpublish: requestUnpublish,
    preview: openPreview,
  })
  useEffect(() => {
    commandActionsRef.current = {
      save: handleSave,
      publish: handlePublish,
      unpublish: requestUnpublish,
      preview: openPreview,
    }
  })

  const commandShortcut =
    typeof navigator !== "undefined" && /Mac/.test(navigator.platform)
      ? "⌘S"
      : "Ctrl+S"
  // The language's server state, as the Pages list reads it: "draft" means a
  // working draft or a verified base, so an unpublished page stays
  // publishable without a draft row (for example right after Unpublish).
  const localeHasDraft =
    publication?.locales.find((entry) => entry.locale === currentLocale)
      ?.state === "draft"
  const publishDisabled =
    page.status === "archived" ||
    workflow.editingLocked ||
    (page.status !== "published" &&
      (publishReadinessUnavailable ||
        hasPublishBlockers ||
        (workflow.requiresApproval && !workflow.canPublish)))
  const publishDisabledReason =
    page.status === "archived"
      ? t("commands.unarchiveFirst")
      : workflow.editingLocked
        ? t("commands.reviewActive")
        : publishReadinessUnavailable
          ? publishReadinessDisabledReason
          : workflow.requiresApproval && !workflow.canPublish
            ? t("commands.approvalRequired")
            : t("commands.resolveBlockers")
  const currentPageCommands: AdminCommand[] = useMemo(
    () => [
      {
        id: "page-editor:save",
        label: t("commands.savePage"),
        section: t("commands.section"),
        description: hasUnsaved
          ? t("commands.persistLocale")
          : t("commands.noUnsaved"),
        icon: Save,
        shortcut: commandShortcut,
        disabled: workflow.editingLocked || !hasUnsaved || isSaving,
        disabledReason: workflow.editingLocked
          ? t("commands.reviewActive")
          : isSaving
            ? t("commands.saveRunning")
            : t("commands.noUnsaved"),
        run: async () => {
          await commandActionsRef.current.save()
        },
      },
      {
        id: "page-editor:insert-slice",
        label: t("commands.insertSlice"),
        section: t("commands.section"),
        description: t("commands.insertSliceDescription"),
        icon: PlusCircle,
        keywords: ["add section", "content block"],
        run: () => {
          setActivePanel("slices")
          setSlicePickerOpen(true)
        },
      },
      ...(historyInstalled
        ? [
            {
              id: "page-editor:history",
              label: t("commands.history"),
              section: t("commands.section"),
              description: t("commands.historyDescription"),
              icon: History,
              keywords: ["revisions", "rollback", "restore"],
              run: () => {
                setActivePanel("history")
              },
            },
          ]
        : []),
      // A new-language version cannot be published or previewed
      // before the site switches language.
      ...(targetDraftLocale
        ? []
        : [
            {
              id: "page-editor:publish",
              label:
                page.status === "published"
                  ? t("commands.unpublishPage")
                  : t("commands.publishPage"),
              section: t("commands.section"),
              description:
                page.status === "published"
                  ? t("commands.unpublishDescription")
                  : t("commands.publishDescription"),
              icon: page.status === "published" ? Archive : ArrowRight,
              disabled: publishDisabled,
              disabledReason: publishDisabledReason,
              run: () =>
                page.status === "published"
                  ? commandActionsRef.current.unpublish()
                  : commandActionsRef.current.publish(),
            },
            {
              id: "page-editor:preview",
              label: t("commands.previewPage"),
              section: t("commands.section"),
              description: t("commands.previewDescription"),
              icon: ExternalLink,
              run: () => commandActionsRef.current.preview(),
            },
          ]),
    ],
    [
      historyInstalled,
      hasUnsaved,
      isSaving,
      commandShortcut,
      page.status,
      publishDisabled,
      publishDisabledReason,
      workflow.editingLocked,
      setActivePanel,
      setSlicePickerOpen,
      targetDraftLocale,
      t,
    ]
  )
  useRegisterAdminCommands(currentPageCommands)

  function saveFromShortcut() {
    if (hasUnsaved && !isSaving && !workflow.editingLocked) void handleSave()
  }
  const saveFromKey = useEffectEvent(() => saveFromShortcut())

  // Cmd/Ctrl+S save shortcut
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault()
        if (!e.repeat) saveFromKey()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  // Slug persistence cue for the active locale. `slugLocalizes` = this
  // non-default-locale slug differs from the base, so it produces a localized
  // URL segment; `slugIsSaved` = the value in the field is the one persisted
  // (vs. an auto-preview from the title that still needs a Save).
  const effectiveBaseSlug = savedSlugByLocale[defaultLocale] ?? page.slug ?? ""
  const slugLocalizes =
    currentLocale !== defaultLocale && !!slug && slug !== effectiveBaseSlug
  const slugIsSaved =
    currentLocale === defaultLocale
      ? savedSlugByLocale[defaultLocale] === slug
      : slugLocalizes
        ? savedSlugByLocale[currentLocale] === slug
        : savedSlugByLocale[currentLocale] === undefined
  const effectiveSelectedSliceId =
    selectedSliceId &&
    slices.some((slice) => readSlice(slice).id === selectedSliceId)
      ? selectedSliceId
      : null
  const effectiveFocusedFieldTarget =
    focusedFieldTarget &&
    slices.some((slice) => readSlice(slice).id === focusedFieldTarget.sliceId)
      ? focusedFieldTarget
      : null
  const effectiveFocusedFirstControlTarget =
    focusedFirstControlTarget &&
    slices.some(
      (slice) => readSlice(slice).id === focusedFirstControlTarget.sliceId
    )
      ? focusedFirstControlTarget
      : null
  const activeEditorCount = activeEditors?.length ?? 0
  const activeEditorLabel =
    activeEditorCount === 0
      ? t("activeEditors.none")
      : t("activeEditors.count", { count: activeEditorCount })
  const editorLockLabel =
    !pageEditorLock || pageEditorLock.status === "available"
      ? t("focus.open")
      : pageEditorLock.isMine
        ? t("focus.yours")
        : t("focus.owner", {
            label:
              pageEditorLock.lock.name ??
              pageEditorLock.lock.email ??
              t("focus.editor"),
          })
  const recoverySummary = recoveryDraft
    ? [
        recoveryDraft.locale !== currentLocale
          ? t("recovery.locale", { locale: recoveryDraft.locale.toUpperCase() })
          : null,
        recoveryDraft.title !== title ? t("recovery.titleDiffers") : null,
        recoveryDraft.slices.length !== slices.length
          ? t("recovery.sliceCount", {
              count: recoveryDraft.slices.length,
            })
          : null,
      ].filter(Boolean)
    : []

  function focusPreviewField(
    target: PreviewFieldSelection,
    result?: PreviewInlineActivationResult
  ) {
    setActivePanel("slices")
    setSelectedSliceId(target.sliceId)
    setPreviewInlineRefusal(result?.status === "refused" ? result.reason : null)
    // A newer preview action replaces any pending form focus, so a slow
    // editor load cannot pull focus away from what the user chose since.
    if (result?.status === "activated") {
      setFocusedFieldTarget(null)
      return
    }
    setFocusedFieldTarget((current) => ({
      ...target,
      nonce: (current?.nonce ?? 0) + 1,
    }))
  }

  function focusPreviewSliceForm(sliceId: string) {
    setActivePanel("slices")
    setSelectedSliceId(sliceId)
    setPreviewInlineRefusal("unsupported")
    setFocusedFieldTarget(null)
    setFocusedFirstControlTarget((current) => ({
      sliceId,
      nonce: (current?.nonce ?? 0) + 1,
    }))
  }

  function handlePreviewInlineEdit(commit: PreviewInlineEditCommit) {
    if (recoveryDraft) {
      refuseForRecovery()
      return false
    }
    if (repeatedPreviewConflictRef.current) return false
    const current = rebasePageField(
      slicesRef.current,
      activeLocaleRef.current,
      commit,
      slicesEpochRef.current,
      presentationCatalog?.revision ?? ""
    )
    const pendingReports: TitleWriteReport[] = []
    const next = applyPageField(
      slicesRef.current,
      activeLocaleRef.current,
      current,
      slicesEpochRef.current,
      presentationCatalog?.revision ?? "",
      (report) => {
        pendingReports.push(report)
      }
    )
    if (!next) return false
    // This is the same descriptor-shaped value path used by the sidebar.
    // Advance synchronously so Save never waits on a React render or frame capture.
    try {
      const prepared = prepareIncomingDraft({
        slices: next,
        removedTitleLinks: pendingReports,
      })
      commitPreparedSlices(prepared, false)
      scheduleSidebarPublicationIfFocused()
      return true
    } catch {
      return false
    }
  }

  function handlePreviewActiveEditHandleChange(
    handle: PreviewActiveEditHandle | null
  ) {
    activePreviewEditRef.current = handle
  }

  function handlePreviewActiveEditChange(
    commit: PreviewInlineEditCommit | null
  ) {
    previewEditBufferRef.current = commit
  }

  function handleDiscardRecoveryDraft() {
    activePreviewEditRef.current?.discardActiveEdit?.()
    repeatedPreviewConflictRef.current = null
    setRepeatedPreviewConflict(null)
    handlePreviewActiveEditChange(null)
    discardRecoveryDraft()
  }

  function handlePreviewActiveEditConflict(
    requested?: PreviewInlineEditCommit | null
  ) {
    // Same as a default parameter (undefined falls back to the buffer), but
    // read in the body: React Compiler rejects a ref read in a default.
    const pending =
      requested === undefined ? previewEditBufferRef.current : requested
    if (!pending) return
    // Only rejected data is retained here, in the parent. Never replace the
    // canonical field with an outdated value or reinterpret an old item index.
    const firstConflict = repeatedPreviewConflictRef.current === null
    repeatedPreviewConflictRef.current = pending
    setRepeatedPreviewConflict(pending)
    if (firstConflict) toast.error(t("sliceChanged"))
  }

  function renderEditor(
    writing: AdminAiWritingPageEditorHostResult | null,
    translation: AdminAiTranslationHostResult | null
  ) {
    const fieldGenerate = writing?.fieldGenerate
    const fieldTranslate = translation?.fieldTranslate
    const metaGenerationAvailable = writing?.metaGenerationAvailable ?? false
    const isGeneratingMeta = writing?.isGeneratingMeta ?? false
    const translationBusy = translation?.busy ?? false
    const contributionCommands = [
      ...(writing?.commands ?? []),
      ...(translation?.command ? [translation.command] : []),
    ]

    return (
      <div className="flex h-screen flex-col">
        <PageEditorContributionCommands commands={contributionCommands} />
        {/* Unsaved banner — suppressed while a save is in flight so it doesn't
          briefly reappear alongside the "Saved" toast (Friction E). */}
        {hasUnsaved && !isSaving && (
          <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800">
            <span className="font-medium">{t("unsavedChanges")}</span>
            {!recoveryDraft && (
              <span className="text-amber-600">
                {t("saveShortcut", { shortcut: commandShortcut })}
              </span>
            )}
          </div>
        )}
        {repeatedPreviewConflict && (
          <div className="space-y-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-950">
            <p role="alert">{t("recovery.repeatedTargetConflict")}</p>
            <textarea
              readOnly
              aria-label={t("recovery.pendingText")}
              value={repeatedPreviewConflict.value}
              className="w-full rounded border bg-background p-2 text-foreground"
            />
            <button type="button" onClick={handleDiscardRecoveryDraft}>
              {t("recovery.discard")}
            </button>
          </div>
        )}
        {recoveryDraft && (
          <div
            className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-sky-200 bg-sky-50 px-4 py-2 text-xs text-sky-900 ${
              recoveryRefused ? "ring-2 ring-sky-700 ring-inset" : ""
            }`}
          >
            <div className="flex min-w-0 flex-1 basis-0 items-center gap-2">
              <AlertTriangle className="size-4 shrink-0" />
              <span className="font-medium">{t("recovery.browserDraft")}</span>
              <span className="truncate text-sky-700">
                {new Date(recoveryDraft.savedAt).toLocaleString(adminLocale)}
                {recoverySummary.length > 0
                  ? ` - ${recoverySummary.join(", ")}`
                  : ""}
              </span>
            </div>
            {recoveryRefused && (
              <p
                role="alert"
                className="order-last basis-full font-semibold text-sky-950 xl:order-none xl:basis-auto"
              >
                {tPageSave("resolveRecovery")}
              </p>
            )}
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => applyRecoveryDraft(recoveryDraft)}
                className="rounded-md bg-sky-700 px-2.5 py-1 font-medium text-white hover:bg-sky-800"
              >
                {t("recovery.restore")}
              </button>
              <button
                type="button"
                onClick={handleDiscardRecoveryDraft}
                className="rounded-md border border-sky-300 px-2.5 py-1 font-medium hover:bg-sky-100"
              >
                {t("recovery.discard")}
              </button>
            </div>
          </div>
        )}
        {recoveryDraft &&
          (!isCurrentSourceRecovery(
            recoveryDraft,
            page.pageType,
            currentLocale
          ) ||
            Boolean(recoveryDraft.inlineConflicts?.length)) && (
            <textarea
              readOnly
              aria-label={t("recovery.pendingText")}
              value={JSON.stringify(recoveryDraft)}
              className="w-full rounded border p-2"
            />
          )}
        {retainedTargetRemedy && (
          <div className="flex items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-950">
            <div className="min-w-0">
              <p className="font-medium">
                {t("retainedTargetRemedy.heading", {
                  locale: getLocaleDisplayName(retainedTargetRemedy.locale),
                })}
              </p>
              <p className="text-amber-800">
                {t("retainedTargetRemedy.description", {
                  locale: getLocaleDisplayName(retainedTargetRemedy.locale),
                })}
              </p>
            </div>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={deletingRetainedTargetDraft}
              onClick={() => void handleDeleteRetainedTargetDraft()}
            >
              {t("retainedTargetRemedy.action", {
                locale: getLocaleDisplayName(retainedTargetRemedy.locale),
              })}
            </Button>
          </div>
        )}

        {/* Phone: identity above locale and named icon actions. The extra top
          clearance keeps this row below the shell's fixed sidebar toggle.
          Desktop: identity owns the full first row; actions wrap below it. */}
        <header className="relative -mx-6 mb-3 grid shrink-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-1 gap-y-2 border-b bg-background px-3 pt-6 pb-2 sm:mx-0 sm:flex sm:flex-col sm:items-stretch sm:gap-3 sm:px-4 sm:py-3">
          <h1 className="sr-only">{title || t("pageTitle")}</h1>
          {/* Identity + attention indicators */}
          <div className="contents sm:flex sm:w-full sm:min-w-0 sm:items-center sm:gap-3">
            <div className="col-span-3 flex min-w-0 items-center gap-1 pr-12 sm:flex-1 sm:gap-3 sm:pr-0">
              <button
                type="button"
                onClick={() =>
                  router.push(
                    targetDraftLocale
                      ? "/admin/settings/languages"
                      : "/admin/pages"
                  )
                }
                aria-label={
                  targetDraftLocale
                    ? t("backToLanguageChange")
                    : t("backToPages")
                }
                className="flex size-11 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent sm:size-auto sm:p-1.5"
              >
                <ArrowLeft className="size-4" />
              </button>
              <div className="min-w-0 flex-1">
                <input
                  id="page-title"
                  type="text"
                  aria-label={t("pageTitle")}
                  value={title}
                  onChange={(e) => handleTitleChange(e.target.value)}
                  disabled={workflow.editingLocked}
                  placeholder={t("pageTitle")}
                  aria-invalid={titleMissing || undefined}
                  aria-describedby={titleMissing ? titleRequiredId : undefined}
                  className="w-full border-none bg-transparent text-base font-semibold outline-none placeholder:text-muted-foreground/50 focus:ring-0 aria-invalid:ring-3 aria-invalid:ring-destructive/20 sm:rounded-sm sm:focus-visible:ring-3 sm:focus-visible:ring-ring/50 sm:aria-invalid:focus-visible:ring-destructive/40 dark:aria-invalid:ring-destructive/40"
                />
                <div className="mt-0.5 flex min-w-0 items-center gap-2">
                  {titleMissing ? (
                    <span
                      id={titleRequiredId}
                      className="flex min-w-0 items-center gap-1 text-xs text-destructive"
                    >
                      <CircleAlert className="size-3.5 shrink-0" />
                      <span className="min-w-0 truncate">
                        {tPageSave("titleRequired")}
                      </span>
                    </span>
                  ) : publication ? null : (
                    <span className="max-w-50 min-w-0 truncate text-xs text-muted-foreground">
                      /{slug}
                    </span>
                  )}
                  {/* Snapshot sites show the active language's status in the
                    header line below; the page-wide badge is legacy only. */}
                  {!publication && (
                    <Badge
                      variant={
                        page.status === "published"
                          ? "default"
                          : page.status === "archived"
                            ? "outline"
                            : "secondary"
                      }
                      className="shrink-0 text-xs"
                    >
                      {page.status === "published"
                        ? t("status.published")
                        : page.status === "archived"
                          ? t("status.archived")
                          : t("status.draft")}
                    </Badge>
                  )}
                  {/* ADR-0041 §Consequences — surfaces the staging row's
                  presence so an editor knows there's unpublished work
                  awaiting a Publish click. Owner rule: plain language. */}
                  {hasStaging && (
                    <Badge
                      variant="outline"
                      className="shrink-0 border-amber-500/50 bg-amber-100/40 text-xs text-amber-800 max-sm:size-2 max-sm:rounded-full max-sm:border-0 max-sm:bg-amber-500 max-sm:p-0 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100 dark:max-sm:bg-amber-500"
                      title={t("unpublishedHint")}
                    >
                      <span className="sr-only sm:not-sr-only">
                        {t("unpublishedChanges")}
                      </span>
                    </Badge>
                  )}
                </div>
                {publication && (
                  <div className="mt-1">
                    <PageHeaderMeta
                      locale={currentLocale}
                      defaultLocale={defaultLocale}
                      entry={publication.locales.find(
                        (entry) => entry.locale === currentLocale
                      )}
                      pageType={page.pageType}
                      isHome={
                        (siteConfig?.homePageId ?? routeHomePageId) === page._id
                      }
                      archived={page.status === "archived"}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Warnings anchored with identity: an editor sees "what's wrong with
              this page" next to what the page IS, not lost among the action
              cluster on the right. */}
            <div className="col-start-2 row-start-2 flex shrink-0 items-center gap-2 sm:[&>button]:flex sm:[&>button]:size-8 sm:[&>button]:gap-0 sm:[&>button]:border-0 sm:[&>button]:p-0 sm:[&>button>span]:sr-only">
              <PageReadinessTrigger
                checklist={visiblePrePublishChecklist}
                checklistError={prePublishChecklistError}
                onRetry={retryPrePublishChecklist}
                warningsAcknowledged={warningsAcknowledged}
                canGenerateMeta={
                  canGenerate &&
                  metaGenerationAvailable &&
                  currentLocale === defaultLocale &&
                  hasAnyContent(slices, title)
                }
                isGeneratingMeta={isGeneratingMeta}
                onAction={(suggestion) =>
                  handlePageReadinessAction(suggestion, writing?.generateMeta)
                }
              />
            </div>
          </div>

          {/* Action segments — thin vertical rules separate Presence · Locale ·
            Lifecycle so the eye can find the right cluster without scanning a
            flat row of identically-styled controls. */}
          <div className="contents sm:flex sm:w-full sm:min-w-0 sm:flex-wrap sm:items-center sm:justify-end sm:gap-3">
            {/* Presence */}
            <div className="hidden items-center gap-1 sm:mr-auto sm:flex">
              {savedAt && !hasUnsaved && (
                <span className="hidden text-xs text-muted-foreground xl:block">
                  {t("savedAt", {
                    time: savedAt.toLocaleTimeString(adminLocale),
                  })}
                </span>
              )}
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={`${t("focus.title")}: ${editorLockLabel}`}
                    title={`${t("focus.title")}: ${editorLockLabel}`}
                    className="hidden size-8 items-center justify-center rounded-md text-xs transition-colors hover:bg-accent md:flex"
                  >
                    <Lock className="size-3.5 shrink-0" aria-hidden />
                    <span className="sr-only">{editorLockLabel}</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-80 p-3">
                  <div className="space-y-3">
                    <div>
                      <div className="text-xs font-semibold text-muted-foreground uppercase">
                        {t("focus.title")}
                      </div>
                      {!pageEditorLock ? (
                        <p className="mt-1 text-sm text-muted-foreground">
                          {t("loading")}
                        </p>
                      ) : pageEditorLock.status === "available" ? (
                        <p className="mt-1 text-sm text-muted-foreground">
                          {t("focus.unclaimed")}
                        </p>
                      ) : (
                        <p className="mt-1 text-sm">
                          {pageEditorLock.isMine
                            ? t("focus.youHaveFocus")
                            : t("focus.hasFocus", {
                                label:
                                  pageEditorLock.lock.name ??
                                  pageEditorLock.lock.email ??
                                  t("focus.anotherEditor"),
                              })}
                        </p>
                      )}
                    </div>

                    {pageEditorLock?.status === "locked" && (
                      <p className="text-xs text-muted-foreground">
                        {t("focus.lastActive", {
                          time: new Date(
                            pageEditorLock.lock.lastActiveAt
                          ).toLocaleTimeString(adminLocale),
                        })}
                      </p>
                    )}

                    <div className="flex items-center gap-2">
                      {pageEditorLock?.status === "locked" &&
                      pageEditorLock.isMine ? (
                        <button
                          type="button"
                          onClick={() => void handleReleaseEditorLock()}
                          className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent"
                        >
                          {t("focus.release")}
                        </button>
                      ) : pageEditorLock?.status === "locked" ? (
                        <button
                          type="button"
                          onClick={() => void handleAcquireEditorLock(true)}
                          className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                        >
                          {t("focus.takeOver")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void handleAcquireEditorLock(false)}
                          className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                        >
                          {t("focus.claim")}
                        </button>
                      )}
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label={`${t("activeEditors.title")}: ${activeEditorLabel}`}
                    title={`${t("activeEditors.title")}: ${activeEditorLabel}`}
                    className="hidden size-8 items-center justify-center rounded-md text-xs transition-colors hover:bg-accent md:flex"
                  >
                    <Users className="size-3.5" aria-hidden />
                    <span className="sr-only">{activeEditorLabel}</span>
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 p-3">
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-muted-foreground uppercase">
                      {t("activeEditors.editingNow")}
                    </div>
                    {!activeEditors ? (
                      <p className="text-sm text-muted-foreground">
                        {t("loading")}
                      </p>
                    ) : activeEditors.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {t("activeEditors.noRecent")}
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {activeEditors.map((editor) => {
                          const label =
                            editor.name ??
                            editor.email ??
                            t("activeEditors.unknown")
                          return (
                            <div
                              key={editor._id}
                              className="flex items-center justify-between gap-3"
                            >
                              <span className="truncate text-sm font-medium">
                                {label}
                              </span>
                              <span className="shrink-0 text-xs text-muted-foreground">
                                {new Date(
                                  editor.lastActiveAt
                                ).toLocaleTimeString(adminLocale)}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </PopoverContent>
              </Popover>
            </div>

            <div className="mx-1 hidden h-6 w-px shrink-0 bg-border md:block" />

            {/* Locale + content tools — LocaleTabs is the production pill; Copy /
              Translate keep their existing pull/push popovers. */}
            {targetDraftLocale ? (
              <Badge
                variant="outline"
                className="col-start-1 row-start-2 max-w-full text-xs whitespace-normal"
              >
                {t("privateVersion", {
                  locale: getLocaleDisplayName(targetDraftLocale),
                })}
              </Badge>
            ) : (
              // The language switch never shrinks: a control that does not fit
              // beside it (Translate) wraps onto its own line below.
              <div className="col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-1">
                <LocaleTabs
                  currentLocale={currentLocale}
                  enabledLocales={enabledLocales}
                  availableLocales={localesWithContent}
                  onLocaleChange={handleLocaleChange}
                  className="max-w-full shrink-0 overflow-x-auto max-sm:p-0 [&>button]:shrink-0 max-sm:[&>button]:min-h-11 max-sm:[&>button]:min-w-11"
                />
                {canCopyContent && (
                  <Popover open={copyOpen} onOpenChange={setCopyOpen}>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        title={t("copyBetweenLocales")}
                        disabled={translationBusy}
                        aria-label={t("copyBetweenLocales")}
                        className="hidden size-8 items-center justify-center rounded-md text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 sm:flex"
                      >
                        <Copy className="size-3.5" aria-hidden />
                        <span className="sr-only">{t("copy")}</span>
                      </button>
                    </PopoverTrigger>
                    <TransferPopoverContent
                      mode="copy"
                      currentLocale={currentLocale}
                      otherLocales={otherLocales}
                      currentHasContent={currentHasContent}
                      currentSummary={currentSummary}
                      isTranslating={translationBusy}
                      showPushOut={showPushOut}
                      setShowPushOut={setShowPushOut}
                      hasContentForMode={hasContentForModeInRender}
                      onPullCopy={(loc) => handlePullCopy(loc)}
                      onCloseAutoFocus={focusTitleOnCloseAutoFocus}
                      onPush={(loc) =>
                        void handlePush(loc, "copy", translation)
                      }
                    />
                  </Popover>
                )}
                {translation?.control}
              </div>
            )}

            <div className="mx-1 hidden h-6 w-px shrink-0 bg-border md:block" />

            {/* Lifecycle — More menu carries the low-frequency lifecycle actions
              (Duplicate/Discard/Unpublish/Archive) so Save · Preview ·
              Publish stay the visible primaries. Archived pages skip the menu
              entirely — Unarchive is the only meaningful action from there. */}
            <div className="col-start-3 row-start-2 flex items-center gap-1 sm:gap-2">
              {page.status !== "archived" && !targetDraftLocale && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("moreActions")}
                      title={t("moreActions")}
                      className="absolute top-6 right-3 size-11 sm:static sm:size-8"
                    >
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel>{t("page")}</DropdownMenuLabel>
                    {canDuplicate && (
                      <DropdownMenuItem onSelect={() => setDuplicateOpen(true)}>
                        <CopyPlus className="size-4" />
                        {t("duplicate")}
                      </DropdownMenuItem>
                    )}
                    {/* ADR-0041 §9 — Discard is only meaningful when a
                      staging row exists; the handler uniformly reverts
                      to the last saved state. */}
                    {hasStaging && (
                      <DropdownMenuItem
                        disabled={isSaving || workflow.editingLocked}
                        onSelect={() => handleDiscard()}
                      >
                        <Trash2 className="size-4" />
                        {t("discard.menuAction")}
                      </DropdownMenuItem>
                    )}
                    {(canDuplicate || hasStaging) &&
                      (page.status === "published" ||
                        page.status === "draft") && <DropdownMenuSeparator />}
                    {page.status === "published" && (
                      <DropdownMenuItem
                        disabled={workflow.editingLocked}
                        onSelect={requestUnpublish}
                      >
                        {t("unpublish")}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      disabled={workflow.editingLocked}
                      onSelect={() => void handleArchive()}
                    >
                      <Archive className="size-4" />
                      {t("archive")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <button
                type="button"
                data-preview-save-control
                onClick={handleSave}
                title={isSaving ? t("saving") : t("save")}
                disabled={workflow.editingLocked || !hasUnsaved || isSaving}
                className="inline-flex size-11 items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 sm:h-auto sm:w-auto sm:px-3 sm:py-1.5"
              >
                {isSaving ? (
                  <Loader2
                    className="size-4 animate-spin sm:hidden"
                    aria-hidden
                  />
                ) : (
                  <Save className="size-4 sm:hidden" aria-hidden />
                )}
                <span className="sr-only sm:not-sr-only">
                  {isSaving ? t("saving") : t("save")}
                </span>
              </button>
              {!targetDraftLocale && (
                <>
                  <button
                    type="button"
                    onClick={openPreview}
                    title={t("preview")}
                    className="inline-flex size-11 items-center justify-center rounded-md text-sm transition-colors hover:bg-accent sm:h-auto sm:w-auto sm:gap-1.5 sm:border sm:px-3 sm:py-1.5"
                  >
                    <Eye className="size-3.5" aria-hidden />
                    <span className="sr-only sm:not-sr-only">
                      {t("preview")}
                    </span>
                  </button>
                  {page.status === "archived" ? (
                    <button
                      type="button"
                      onClick={handleUnarchive}
                      title={t("unarchive")}
                      disabled={workflow.editingLocked}
                      className="inline-flex size-11 items-center justify-center rounded-md bg-emerald-600 text-sm font-medium text-white transition-colors hover:bg-emerald-700 sm:h-auto sm:w-auto sm:px-3 sm:py-1.5"
                    >
                      <ArchiveRestore
                        className="size-4 sm:hidden"
                        aria-hidden
                      />
                      <span className="sr-only sm:not-sr-only">
                        {t("unarchive")}
                      </span>
                    </button>
                  ) : page.status === "published" ? (
                    // Republish button — enabled only when there's staged work
                    // to promote. Same permission gate as first publish
                    // (`pages.<type>:publish`).
                    <button
                      type="button"
                      data-preview-save-control
                      onClick={handlePublish}
                      disabled={
                        publishReadinessUnavailable ||
                        hasPublishBlockers ||
                        (workflow.requiresApproval && !workflow.canPublish) ||
                        (!hasStaging && !hasUnsaved && !localeHasDraft)
                      }
                      title={
                        publishReadinessUnavailable
                          ? publishReadinessDisabledReason
                          : hasPublishBlockers
                            ? t("commands.resolveBlockers")
                            : workflow.requiresApproval && !workflow.canPublish
                              ? t("commands.approvalRequired")
                              : !hasStaging && !hasUnsaved && !localeHasDraft
                                ? t("nothingToPublish.noChanges")
                                : t("publishUnpublished")
                      }
                      className="inline-flex size-11 items-center justify-center rounded-md bg-emerald-600 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 sm:h-auto sm:w-auto sm:px-3 sm:py-1.5"
                    >
                      <Upload className="size-4 sm:hidden" aria-hidden />
                      <span className="sr-only sm:not-sr-only">
                        {t("publishChanges")}
                      </span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-preview-save-control
                      onClick={handlePublish}
                      disabled={
                        publishReadinessUnavailable ||
                        hasPublishBlockers ||
                        (workflow.requiresApproval && !workflow.canPublish) ||
                        (!hasStaging && !hasUnsaved && !localeHasDraft)
                      }
                      title={
                        publishReadinessUnavailable
                          ? publishReadinessDisabledReason
                          : hasPublishBlockers
                            ? t("commands.resolveBlockers")
                            : workflow.requiresApproval && !workflow.canPublish
                              ? t("commands.approvalRequired")
                              : !hasStaging && !hasUnsaved && !localeHasDraft
                                ? t("nothingToPublish.saveFirst")
                                : t("publish")
                      }
                      className="inline-flex size-11 items-center justify-center rounded-md bg-emerald-600 text-sm font-medium text-white transition-colors hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 sm:h-auto sm:w-auto sm:px-3 sm:py-1.5"
                    >
                      <Upload className="size-4 sm:hidden" aria-hidden />
                      <span className="sr-only sm:not-sr-only">
                        {t("publish")}
                      </span>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </header>

        {/* Same condition as the header's Translation control. */}
        {!targetDraftLocale && translation?.panel}

        {languageChangeNotice && (
          <div
            role="note"
            className="mx-4 mb-3 space-y-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          >
            {languageChangeNotice.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        )}

        {!targetDraftLocale && (
          <EditionPageWorkflow
            pageId={page._id}
            workflow={workflow}
            hasStaging={hasStaging}
            hasUnsaved={hasUnsaved}
            ensureSaved={ensureSaved}
            onPublish={handlePublish}
          />
        )}

        <UnpublishDialog
          request={unpublishAsk}
          onCancel={() => setUnpublishAsk(null)}
          onConfirm={() => {
            setUnpublishAsk(null)
            void handleUnpublish()
          }}
        />

        {duplicateOpen && page.pageType !== "author" && (
          <DuplicatePageDialog
            pageId={page._id}
            sourceTitle={
              (currentLocale === defaultLocale
                ? title
                : getTitle(page, defaultLocale)) || title
            }
            beforeDuplicate={saveBeforeDuplicate}
            onCloseAutoFocus={focusTitleOnCloseAutoFocus}
            onClose={() => setDuplicateOpen(false)}
            onDuplicated={(newId) => router.push(`/admin/pages/${newId}`)}
          />
        )}

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">
          {/* Side icon tabs */}
          <nav
            aria-label={t("page")}
            className="flex w-12 shrink-0 flex-col items-center gap-1 border-r bg-muted/20 py-3"
          >
            {(() => {
              // Non-routable content types (testimonial — plan 029 C10) have
              // no public URL to serve SEO metadata against, and their
              // pure-form arm's `localizedValidator` doesn't accept
              // `metaTitle`/`metaDescription` — so the SEO tab is hidden.
              // Otherwise an editor could type meta on a testimonial, hit
              // Save, get a success toast, and reload to find the data
              // silently dropped by the strict per-arm draft input.
              const routable =
                adminContentTypes().find((t) => t.type === page.pageType)
                  ?.routable !== false
              const tabs = [
                {
                  id: "slices" as const,
                  icon: Layers,
                  title: t("tabs.content"),
                },
                ...(routable
                  ? [{ id: "seo" as const, icon: Search, title: t("tabs.seo") }]
                  : []),
                {
                  id: "settings" as const,
                  icon: Settings,
                  title: t("tabs.settings"),
                },
                ...(historyInstalled
                  ? [
                      {
                        id: "history" as const,
                        icon: History,
                        title: t("tabs.history"),
                      },
                    ]
                  : []),
              ] as const
              return tabs
            })().map(({ id, icon: Icon, title: t }) => (
              <button
                key={id}
                type="button"
                title={t}
                aria-pressed={activePanel === id}
                onClick={() => setActivePanel(id)}
                className={`rounded-md p-2.5 transition-colors ${
                  activePanel === id
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50"
                }`}
              >
                <Icon className="size-4" />
              </button>
            ))}
          </nav>

          {/* Main panel */}
          <div className="flex-1 overflow-y-auto p-6 motion-safe:scroll-smooth">
            <fieldset
              disabled={workflow.editingLocked}
              className="contents disabled:cursor-not-allowed disabled:opacity-70"
            >
              {(() => {
                const contentTypeSummary = adminContentTypes().find(
                  (t) => t.type === page.pageType
                )
                const capabilities = adminContentTypeCapabilities(page.pageType)
                const fieldSourceLocalized =
                  fieldSource !== undefined
                    ? extractLocalizedFieldValues(
                        page,
                        adminContentTypeLocalizedFields(page.pageType),
                        fieldSource
                      )
                    : undefined
                return (
                  <div
                    hidden={activePanel !== "slices"}
                    className="w-full space-y-6"
                  >
                    {contentTypeSummary && (
                      <ContentTypeFieldsPanel
                        contentType={contentTypeSummary}
                        sharedValues={sharedFieldValues}
                        localizedValues={localizedFieldValues}
                        onSharedChange={setSharedFieldValues}
                        onLocalizedChange={setLocalizedFieldValues}
                        currentLocale={currentLocale}
                        sourceLocalizedValues={fieldSourceLocalized}
                        translate={fieldTranslate}
                        generate={fieldGenerate}
                      />
                    )}
                    {capabilities.sliceBody && (
                      <SlicesPanel
                        pageId={page._id}
                        pageType={pageType}
                        languageVersion={siteConfig?.languageVersion}
                        contentEpoch={slicesEpoch}
                        draftRevision={draftRevision}
                        getDraftRevision={() => draftRevisionRef.current}
                        inlineEditingBlocked={
                          Boolean(recoveryDraft || repeatedPreviewConflict) ||
                          workflow.editingLocked
                        }
                        currentLocale={currentLocale}
                        defaultLocale={defaultLocale}
                        title={title}
                        slices={slices}
                        presentationCatalog={presentationCatalog}
                        otherLocales={otherLocales}
                        sourceSlices={fieldSourceSlices}
                        fieldTranslate={fieldTranslate}
                        fieldGenerate={fieldGenerate}
                        slicePickerOpen={slicePickerOpen}
                        selectedSliceId={effectiveSelectedSliceId}
                        focusedFieldTarget={effectiveFocusedFieldTarget}
                        focusedFirstControlTarget={
                          effectiveFocusedFirstControlTarget
                        }
                        previewInlineRefusal={previewInlineRefusal}
                        previewInlineEditingEnabled={
                          previewInlineEditingEnabled
                        }
                        onSlicesChange={setSlices}
                        onSlicePickerOpenChange={setSlicePickerOpen}
                        onSelectedSliceIdChange={setSelectedSliceId}
                        onPreviewSelectSlice={(sliceId) => {
                          setActivePanel("slices")
                          setSelectedSliceId(sliceId)
                          setFocusedFieldTarget(null)
                        }}
                        onPreviewSelectSliceFallback={focusPreviewSliceForm}
                        onPreviewSelectField={focusPreviewField}
                        onPreviewInlineEditCommit={handlePreviewInlineEdit}
                        onPreviewActiveEditHandleChange={
                          handlePreviewActiveEditHandleChange
                        }
                        onPreviewActiveEditChange={
                          handlePreviewActiveEditChange
                        }
                        onPreviewActiveEditConflict={
                          handlePreviewActiveEditConflict
                        }
                        onPreviewInlineEditingEnabledChange={
                          setPreviewInlineEditingEnabled
                        }
                        onSave={saveFromShortcut}
                        onOpenSavedPreview={openPreview}
                        archiveStateVerificationFailure={
                          archiveStateVerificationFailure
                        }
                      />
                    )}
                  </div>
                )
              })()}

              {activePanel === "seo" && (
                <SeoPanel
                  currentLocale={currentLocale}
                  title={title}
                  slices={slices}
                  metaTitle={metaTitle}
                  metaDescription={metaDescription}
                  seoNoIndex={seoNoIndex}
                  seoNoFollow={seoNoFollow}
                  seoOgTitle={seoOgTitle}
                  seoOgDescription={seoOgDescription}
                  seoOgImage={seoOgImage}
                  canGenerate={canGenerate}
                  metaGenerationAvailable={metaGenerationAvailable}
                  isGeneratingMeta={isGeneratingMeta}
                  fieldSourceMetaTitle={fieldSourceMetaTitle}
                  fieldSourceMetaDescription={fieldSourceMetaDescription}
                  fieldTranslate={fieldTranslate}
                  fieldGenerate={fieldGenerate}
                  onGenerateMeta={() => void writing?.generateMeta()}
                  onMetaTitleChange={setMetaTitle}
                  onMetaDescriptionChange={setMetaDescription}
                  onSeoNoIndexChange={setSeoNoIndex}
                  onSeoNoFollowChange={setSeoNoFollow}
                  onSeoOgTitleChange={setSeoOgTitle}
                  onSeoOgDescriptionChange={setSeoOgDescription}
                  onSeoOgImageChange={setSeoOgImage}
                />
              )}

              {activePanel === "settings" && (
                <div className="space-y-6">
                  <SettingsPanel
                    page={page}
                    currentLocale={currentLocale}
                    defaultLocale={defaultLocale}
                    title={title}
                    slug={slug}
                    slugLinked={slugLinked || allocatedLinked}
                    slugLocalizes={slugLocalizes}
                    slugIsSaved={slugIsSaved}
                    effectiveBaseSlug={effectiveBaseSlug}
                    pageType={pageType}
                    parentId={parentId}
                    authorIds={authorIds}
                    tags={tags}
                    parentOptions={parentOptions}
                    addressAvailability={addressAvailability}
                    addressWasTyped={addressWasTyped}
                    fieldSourceTitle={fieldSourceTitle}
                    fieldTranslate={fieldTranslate}
                    fieldGenerate={fieldGenerate}
                    onTitleChange={handleTitleChange}
                    onSlugChange={handleSlugChange}
                    onParentIdChange={setParentId}
                    onAuthorIdsChange={setAuthorIds}
                    onTagsChange={setTags}
                    {...(targetDraftLocale
                      ? {}
                      : {
                          onArchive: () => void handleArchive(),
                          onDelete: () => void handleDelete(),
                        })}
                  />
                </div>
              )}

              {HistoryPanelSlot && activePanel === "history" && (
                <HistoryPanelSlot
                  pageId={page._id}
                  pageType={page.pageType}
                  restoreBlocked={Boolean(publication)}
                  snapshotRestore={
                    publication && !targetDraftLocale
                      ? { locale: currentLocale }
                      : undefined
                  }
                  readSnapshotRestore={readSnapshotRestore}
                  restoreDisabled={hasUnsaved || isSaving}
                  captureEditorScope={captureEditorScope}
                  captureRestoreReconciliation={captureRestoreReconciliation}
                  onSnapshotRestored={(result) =>
                    onHistoryRestored({
                      ...result,
                      pageId: page._id,
                      sharedSaveBase: captureSaveBase(currentLocale),
                      removedTitleLinks: mergeTitleReports(
                        titleReports.current,
                        result.removedTitleLinks ?? []
                      ),
                    })
                  }
                  onRestored={handleRevisionRestored}
                />
              )}
            </fieldset>
          </div>
        </div>
      </div>
    )
  }

  function readTranslationSourceContent(locale: Locale): LocaleDraft {
    const source = getLocaleEditorContentForTransfer(locale)
    const prepared = prepareIncomingDraft(
      {
        refusalBase: source.draft?.refusalBase,
        title: source.title,
        slug: source.draft?.slug ?? initialSlugFor(locale),
        slugLinked: source.draft?.slugLinked ?? true,
        addressWasTyped: source.draft?.addressWasTyped ?? false,
        metaTitle: source.metaTitle,
        metaDescription: source.metaDescription,
        slices: source.slices,
        removedTitleLinks: source.draft?.removedTitleLinks,
        localizedFieldValues:
          source.draft?.localizedFieldValues ??
          extractLocalizedFieldValues(
            page,
            adminContentTypeLocalizedFields(page.pageType),
            locale
          ),
      },
      locale
    )
    titleReports.current = prepared.removedTitleLinks
    // An unloaded source language is read from the current `page` prop.
    const fromPageProp = locale !== currentLocale && !drafts.current[locale]
    writeLocaleDraft(drafts, locale, prepared)
    if (fromPageProp && publication && publicationRef.current)
      adoptLocaleBase(publicationRef.current, publication, locale)
    return prepared
  }

  function storeTranslationDraft(
    locale: Locale,
    draft: LocaleDraft
  ): LocaleDraft {
    const prepared = prepareIncomingDraft(draft, locale)
    if (prepared.refusalBase === undefined)
      prepared.refusalBase = localeRefusal(locale)
    const summary = summarizeLocaleContent(
      prepared,
      adminContentTypeLocalizedFields(page.pageType)
    )
    titleReports.current = prepared.removedTitleLinks
    writeLocaleDraft(drafts, locale, prepared)
    setDraftSummaries((previous) => ({ ...previous, [locale]: summary }))
    return prepared
  }

  function applyActiveTranslationDraft(draft: LocaleDraft) {
    // The producer passes the exact successfully stored object; no second
    // adoption can fail after cache publication. Direct applies prepare first.
    const prepared =
      drafts.current[currentLocale] === draft
        ? (draft as LocaleDraft & { structuralChange: boolean })
        : prepareIncomingDraft(draft)
    if (prepared.refusalBase === undefined)
      prepared.refusalBase = localeRefusal(currentLocale)
    commitPreparedLocale(prepared)
  }

  // Called when a Translation Accept is pressed, before it saves the open tab.
  // After the server saves the target language's draft, `complete` reloads
  // that tab through the History remount and opens it. Text typed after the
  // press is kept, dirty, on its old base (see the pending-restore effect);
  // other tabs keep their unsaved buffers.
  function beginSavedLanguage(locale: Locale) {
    // Module-level clock, as in captureRestoreReconciliation.
    const restoreStartedAt = currentTimestamp()
    return {
      complete(draftGeneration: number) {
        // A language switch does not cancel the reload; only leaving the page.
        if (!publication || !isEditorPageMounted()) return
        onHistoryRestored({
          pageId: page._id,
          locale,
          draftGeneration,
          sharedDraftGeneration: publication.sharedDraftGeneration,
          restoreStartedAt,
          // Read now: the open tab's save may have moved this baseline.
          saveBase: captureSaveBase(locale),
          requestedEditorLocale: locale,
        })
        router.refresh()
      },
    }
  }

  function renderWithTranslation(
    writing: AdminAiWritingPageEditorHostResult | null
  ) {
    const TranslationSlot = ADMIN_AI_TRANSLATION_BROWSER_BINDING
    return TranslationSlot && aiTranslationRouteData !== undefined ? (
      <TranslationSlot
        routeData={aiTranslationRouteData}
        page={page}
        currentLocale={currentLocale}
        otherLocales={otherLocales}
        fieldSource={fieldSource}
        getLocaleSummary={getRenderLocaleSummary}
        getActiveLocale={() => activeLocaleRef.current}
        ensureSaved={ensureSaved}
        prepareTransfer={prepareParticipantTransfer}
        closeTransfer={() => setShowPushOut(false)}
        readSourceContent={readTranslationSourceContent}
        storeDraft={storeTranslationDraft}
        applyActiveDraft={applyActiveTranslationDraft}
        beginSavedLanguage={beginSavedLanguage}
      >
        {(translation) => renderEditor(writing, translation)}
      </TranslationSlot>
    ) : (
      renderEditor(writing, null)
    )
  }

  const WritingSlot = ADMIN_AI_WRITING_BROWSER_BINDING?.PageEditorSlot
  return WritingSlot && aiWritingRouteData !== undefined ? (
    <WritingSlot
      routeData={aiWritingRouteData}
      page={page}
      locale={currentLocale}
      ensureSaved={ensureSaved}
      slices={slices}
      title={title}
      setMetaTitle={setMetaTitle}
      setMetaDescription={setMetaDescription}
      setActivePanel={setActivePanel}
    >
      {renderWithTranslation}
    </WritingSlot>
  ) : (
    renderWithTranslation(null)
  )
}
