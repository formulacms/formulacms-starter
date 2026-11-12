"use client"

import { usePageAddressMessages } from "@/lib/admin/page-address-messages"

import { adoptHeroTitles } from "@/lib/rich-text/adopt-hero-titles"
import { writeFieldMap } from "@/convex/lib/richtext/write"
import type { TitleWriteReport } from "@/convex/lib/richtext/write"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { ConvexError } from "convex/values"
import { hasErrorCode } from "../../pages-list-errors"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type { FunctionArgs, FunctionReturnType } from "convex/server"
import type { Slice } from "@/convex/lib/slices"
import {
  isPrimitiveValueEmpty,
  type Primitive,
} from "@/convex/lib/slices/primitives"
import {
  adminContentTypeSharedFields,
  adminContentTypeLocalizedFields,
} from "@/lib/admin/content-types"
import {
  extractSharedFieldValues,
  extractLocalizedFieldValues,
} from "../lib/descriptor-values"
import { getTitle, slugify } from "../lib/content"
import { SYSTEM_OWNED_SHARED_FIELDS } from "../lib/system-owned-fields"
import type { Locale } from "@/lib/i18n/config"
import type { PageDraftHandoff } from "../lib/page-draft-handoff"
import { revalidatePagePaths } from "@/app/(core)/admin/(authenticated)/pages/actions"
import type { Buffered, RecoveryBase } from "../lib/publication-base"
import {
  clearRecoveryDraft,
  readRecoveryDraft,
  writeRecoveryDraft,
} from "../lib/recovery"
import {
  type Page,
  type PageEditorRecoveryDraft,
  staleSaveMessage,
} from "../lib/types"
import { hasSliceBody } from "@/convex/lib/pages/sliceBodyContent"

const UNMOUNTED_SCOPE = Symbol("unmounted page editor")
type EditorScope = { key: string; generation: number }

/**
 * Save/publish/discard mutations for the page editor.
 *
 * ADR-0041 §Migration step 2 (item 2) — editor writes flow through
 * `pages.updateDraft` (stages content + descriptor sharedFields + slug +
 * seo), `pages.publish` (promotes staging → live), and
 * `pages.discardDraft` (throws the staged working copy away). The legacy
 * `pages.update` mutation remains on the hook because a subset of fields
 * are NOT staged:
 *
 *   - `parentId` / `clearParent`  — hierarchy moves are live-immediate
 *     (ADR §1 "What stays live-immediate").
 *   - `pageType`                  — cross-arm change (rare; kept live).
 *   - `status` transitions        — unpublish / archive / unarchive are
 *     visibility flips, not content edits.
 *
 * FR2c row C (audit B9) removed Scheduling from the editor: this hook
 * never writes `scheduledAt` or `expiresAt`. Both stay on the page as
 * compatibility fields.
 *
 * The retired per-locale content mutation is gone from the server as of
 * ADR-0041 Deploy 3 (Narrow); its content bag is folded into
 * `updateDraft.content[locale]`.
 */
export type UpdateDraft = (
  args: FunctionArgs<typeof api.cms.pages.updateDraft>
) => Promise<FunctionReturnType<typeof api.cms.pages.updateDraft>>

export type PublishPage = (
  args: FunctionArgs<typeof api.cms.pages.publish>
) => Promise<FunctionReturnType<typeof api.cms.pages.publish>>

export type DiscardDraft = (
  args: FunctionArgs<typeof api.cms.pages.discardDraft>
) => Promise<FunctionReturnType<typeof api.cms.pages.discardDraft>>

export type UpdatePage = (
  args: FunctionArgs<typeof api.cms.pages.update>
) => Promise<
  FunctionReturnType<typeof api.cms.pages.update> & { staged?: boolean }
>

type SnapshotEditorArgs = FunctionArgs<
  typeof api.cms.publication.saveEditorDraft
>

export type SaveSnapshotEditorDraft = (args: {
  expectedPresentationCatalogRevision?: string
  shared?: Omit<NonNullable<SnapshotEditorArgs["shared"]>, "expectedGeneration">
  localized?: Omit<
    NonNullable<SnapshotEditorArgs["localized"]>,
    "expectedGeneration"
  >
}) => Promise<{ updatedAt: number; slug?: string }>

type RouterRefresh = {
  refresh(): void
}

const PUBLICATION_ERROR_MESSAGES = {
  PUBLICATION_REFERENCE_TARGET_LOCALE_UNAVAILABLE:
    "A referenced page isn't published in this language. Publish it first, then try again.",
  PUBLICATION_REFERENCE_TARGET_MISSING:
    "A referenced page no longer exists. Replace the reference, then try again.",
  PUBLICATION_REFERENCE_LIMIT:
    "This page has too many linked items to publish. Remove some links or related pages, then try again.",
  // The server backstop for a save with no address; the editor normally
  // refuses it first, so this covers a draft that slipped past that check.
  SLUG_REQUIRED: "Give the page an address before saving.",
  // The home page can be neither archived nor moved to trash.
  PAGE_HOME_LIFECYCLE_REFUSED: "The home page can’t be archived.",
} as const satisfies Readonly<Record<string, string>>

type PublicationErrorCode = keyof typeof PUBLICATION_ERROR_MESSAGES

function isPublicationErrorCode(value: string): value is PublicationErrorCode {
  return Object.hasOwn(PUBLICATION_ERROR_MESSAGES, value)
}

function knownPublicationErrorCode(
  error: unknown
): PublicationErrorCode | null {
  if (error instanceof ConvexError && typeof error.data === "string") {
    return isPublicationErrorCode(error.data) ? error.data : null
  }
  // Some transports preserve only the formatted Error message. Read it only
  // to recover a known stable code; never render the server message itself.
  if (error instanceof Error) {
    const code = Object.keys(PUBLICATION_ERROR_MESSAGES).find((candidate) =>
      error.message.includes(candidate)
    )
    return code && isPublicationErrorCode(code) ? code : null
  }
  return null
}

const STALE_SAVE_CODES: readonly string[] = [
  "PAGE_LOCALE_DRAFT_STALE",
  "PAGE_SHARED_DRAFT_STALE",
  "PAGE_PUBLICATION_LIFECYCLE_STALE",
]

/**
 * Whether a failed save was refused because another tab or session changed the
 * page first. Convex documents `ConvexError.data` as the stable application
 * error payload, so it is read first; the formatted message is the fallback for
 * transports that keep only the message
 * (https://docs.convex.dev/functions/error-handling/application-errors).
 */
export function isStaleSaveError(error: unknown): boolean {
  return (
    STALE_SAVE_CODES.some((code) => hasErrorCode(error, code)) ||
    (error instanceof Error && error.message.includes(staleSaveMessage))
  )
}

export function pageSaveErrorMessage(
  error: unknown,
  fallback: string,
  messages: Readonly<
    Record<PublicationErrorCode, string>
  > = PUBLICATION_ERROR_MESSAGES
): string {
  const code = knownPublicationErrorCode(error)
  return (code && messages[code]) ?? fallback
}

export type PageSaveDraft = {
  removedTitleLinks?: TitleWriteReport[]
  inlineConflicts?: PageEditorRecoveryDraft["inlineConflicts"]
  title: string
  slug: string
  slugLinked?: boolean
  addressWasTyped?: boolean
  pageType: Page["pageType"]
  parentId: string
  authorIds: Id<"pages">[]
  tags: string[]
  metaTitle: string
  metaDescription: string
  slices: Slice[]
  seoNoIndex: boolean
  seoNoFollow: boolean
  seoOgTitle: string
  seoOgDescription: string
  seoOgImage: string
  /** Descriptor-generic field bags — plan 029 C8. Values keyed by the
   *  descriptor field name, filled from primitive defaults when unset. */
  sharedFieldValues: Record<string, unknown>
  localizedFieldValues: Record<string, unknown>
}

export type RetainedPageSaveBase = {
  locale: Locale
  snapshot: string
  stagingUpdatedAt: number | undefined
  pageUpdatedAt: number
}

export type RetainedSharedPageSaveDraft = Buffered<{
  values: ReturnType<typeof sharedDraftValues>
  baseline: ReturnType<typeof sharedDraftValues>
  saveBase: RetainedPageSaveBase
}>

type UsePageSaveOptions = {
  page: Page
  defaultLocale: Locale
  currentLocale: Locale
  initialPageDraftHandoff: PageDraftHandoff | null
  draft: PageSaveDraft
  retainedSaveBase?: RetainedPageSaveBase
  retainedSharedDraft?: RetainedSharedPageSaveDraft
  recoveryDraftForFlush?(draft: PageSaveDraft): PageSaveDraft
  /** Provided by the editor, whose held base owns snapshot save expectations. */
  getRecoveryBase?(locale: Locale): RecoveryBase | null
  getSharedRefusalBase?(): RecoveryBase | undefined
  /** Counts every write to the editor's draft fields, synchronously. A change
   *  in the count means typing landed that `draftRef` (updated in an effect)
   *  has not seen yet. */
  getDraftWriteCount?(): number
  /** Flush/refuse active composition, then capture the parent-owned draft. */
  onPreparedDraft?(draft: PageSaveDraft): void
  captureDraft?(
    draft: PageSaveDraft,
    isCurrent: () => boolean
  ): PageSaveDraft | null | Promise<PageSaveDraft | null>
  /** Runs only when a localized write (title, content or address) is about to
   *  be sent; shared-field-only saves and unchanged drafts never reach it.
   *  `snapshot` is true on the snapshot-authority path; `addressCleared` is
   *  true when the default locale's saved address was emptied. Return true
   *  when the draft was refused and the caller has already shown its
   *  feedback. */
  refuseDraft?(
    draft: PageSaveDraft,
    context: { snapshot: boolean; addressCleared: boolean }
  ): boolean
  presentationCatalogRevision?: string
  /** ADR-0041 §Migration step 2 (item 1) — the editor's reader is the
   *  staged overlay (`pages.getForEdit`). These props are the initial
   *  values from that read. `hasStaging` seeds the "Unpublished changes"
   *  badge and Publish/Discard button enablement; `stagingUpdatedAt`
   *  seeds the staging-row OCC token for `updateDraft`. Undefined
   *  `stagingUpdatedAt` = lazy-create (there is no staging row yet). */
  hasStaging: boolean
  stagingUpdatedAt: number | undefined
  updateDraft: UpdateDraft
  saveSnapshotDraft?: SaveSnapshotEditorDraft
  refuseAddress?(): boolean
  addressIntent?(): "typed" | "generated"
  onAddressAllocated?(slug: string, wanted: string): void
  publishPage: PublishPage
  discardDraft: DiscardDraft
  updatePage: UpdatePage
  /** Refresh the editor lock immediately before a staged write.
   *
   *  `updateDraft` hard-gates on holding the lock (ADR-0041 §4), and the
   *  heartbeat that renews it is skipped while the tab is hidden — so a user
   *  who switches apps for longer than `PAGE_LOCK_ACTIVE_MS` and comes back
   *  can out-race the visibilitychange beat and hit "Reacquire the editor
   *  lock before saving". Beating here makes the lock fresh at the moment it
   *  is actually checked instead of relying on that race. Cheap: one mutation
   *  per user-initiated save, not per keystroke. Returns false when another
   *  editor legitimately holds the lock, so the caller can surface the normal
   *  take-over affordance rather than a stale-lock error. */
  refreshEditorLock(): Promise<boolean>
  setSavedSlugByLocale(
    update: (previous: Record<string, string>) => Record<string, string>
  ): void
  confirmPrePublishReadiness(): Promise<boolean>
  confirmDiscard(kind: "published" | "never-published"): Promise<boolean>
  onSaveConflict(): Promise<void>
  router: RouterRefresh
}

function snapshotForDraft(draft: PageSaveDraft): string {
  return JSON.stringify({
    title: draft.title,
    slug: draft.slug,
    pageType: draft.pageType,
    parentId: draft.parentId,
    // Include authorIds so a byline swap flips hasUnsaved / enables Save
    // (plan 028 C5 wired the RelationPicker; plan 029 C10 task 14 made it
    // an ordered list — order changes count as unsaved too).
    authorIds: draft.authorIds,
    tags: draft.tags,
    metaTitle: draft.metaTitle,
    metaDescription: draft.metaDescription,
    slices: draft.slices,
    seoNoIndex: draft.seoNoIndex,
    seoNoFollow: draft.seoNoFollow,
    seoOgTitle: draft.seoOgTitle,
    seoOgDescription: draft.seoOgDescription,
    seoOgImage: draft.seoOgImage,
    // Plan 029 C8: descriptor-generic bags participate in unsaved-change
    // detection so editing author roleTitle/bio flips the Save button.
    sharedFieldValues: draft.sharedFieldValues,
    localizedFieldValues: draft.localizedFieldValues,
  })
}

type SharedDraftValues = Pick<
  PageSaveDraft,
  | "pageType"
  | "parentId"
  | "authorIds"
  | "tags"
  | "seoNoIndex"
  | "seoNoFollow"
  | "seoOgTitle"
  | "seoOgDescription"
  | "seoOgImage"
  | "sharedFieldValues"
>

export function sharedDraftValues(draft: SharedDraftValues) {
  return {
    pageType: draft.pageType,
    parentId: draft.parentId,
    authorIds: draft.authorIds,
    tags: draft.tags,
    seoNoIndex: draft.seoNoIndex,
    seoNoFollow: draft.seoNoFollow,
    seoOgTitle: draft.seoOgTitle,
    seoOgDescription: draft.seoOgDescription,
    seoOgImage: draft.seoOgImage,
    sharedFieldValues: draft.sharedFieldValues,
  }
}

function savedBaselineSnapshot(
  page: Page,
  defaultLocale: Locale,
  currentLocale: Locale
): string {
  // A cached or recovered draft is never evidence of persistence. Use the
  // same stored values and descriptor defaults as a fresh editor mount.
  const localeContent = page.content?.[currentLocale] as
    | { metaTitle?: string; metaDescription?: string; slices?: Slice[] }
    | undefined
  return snapshotForDraft({
    title: getTitle(page, currentLocale),
    slug:
      page.localizedSlugs?.[currentLocale] ||
      (currentLocale === defaultLocale
        ? (page.slug ?? "")
        : slugify(getTitle(page, currentLocale))),
    pageType: page.pageType,
    parentId: page.parentId ?? "",
    authorIds:
      page.pageType === "post"
        ? (page.authorIds ?? []).flatMap((author) =>
            author.pageId ? [author.pageId] : []
          )
        : [],
    tags: page.pageType === "post" ? (page.tags ?? []) : [],
    metaTitle: localeContent?.metaTitle ?? "",
    metaDescription: localeContent?.metaDescription ?? "",
    slices: localeContent?.slices ?? [],
    seoNoIndex: page.seo?.noIndex ?? false,
    seoNoFollow: page.seo?.noFollow ?? false,
    seoOgTitle: page.seo?.ogTitle ?? "",
    seoOgDescription: page.seo?.ogDescription ?? "",
    seoOgImage: page.seo?.ogImage ?? "",
    sharedFieldValues: extractSharedFieldValues(
      page,
      adminContentTypeSharedFields(page.pageType)
    ),
    localizedFieldValues: extractLocalizedFieldValues(
      page,
      adminContentTypeLocalizedFields(page.pageType),
      currentLocale
    ),
  })
}

// Module-level so the component bodies hold no unsupported statements. React
// Compiler 1.0.0 silently skips a whole component that contains a `finally`, a
// `throw` inside `try`, or value blocks (optional chaining, `??`, ternaries)
// inside try/catch (react/react#34131, #35605, #35573); ESLint still passes
// (react/react#37789). The work still runs inside the try, so errors map as
// before. `page-editor/compiler-coverage.node.test.ts` guards the result.

async function tryOrElse<T>(
  run: () => Promise<T>,
  onError: (err: unknown) => Promise<T> | T
): Promise<T> {
  try {
    return await run()
  } catch (err) {
    return await onError(err)
  }
}

export function usePageSave({
  page,
  defaultLocale,
  currentLocale,
  draft,
  captureDraft,
  refuseDraft,
  onPreparedDraft,
  presentationCatalogRevision,
  hasStaging: initialHasStaging,
  stagingUpdatedAt: initialStagingUpdatedAt,
  updateDraft,
  saveSnapshotDraft,
  refuseAddress,
  addressIntent,
  onAddressAllocated,
  publishPage,
  discardDraft,
  updatePage,
  refreshEditorLock,
  setSavedSlugByLocale,
  confirmPrePublishReadiness,
  confirmDiscard,
  onSaveConflict,
  router,
  recoveryDraftForFlush,
  getRecoveryBase,
  getSharedRefusalBase,
  getDraftWriteCount,
  retainedSaveBase,
  retainedSharedDraft,
}: UsePageSaveOptions) {
  const t = useTranslations("editor.pageSave")
  const addressMessages = usePageAddressMessages(defaultLocale)
  const displayError = useCaughtError()
  const publicationErrorMessages: Readonly<
    Record<PublicationErrorCode, string>
  > = {
    PUBLICATION_REFERENCE_TARGET_LOCALE_UNAVAILABLE: t(
      "publication.targetLocaleUnavailable"
    ),
    PUBLICATION_REFERENCE_TARGET_MISSING: t("publication.targetMissing"),
    PUBLICATION_REFERENCE_LIMIT: t("publication.referenceLimit"),
    SLUG_REQUIRED: t("slugRequired"),
    PAGE_HOME_LIFECYCLE_REFUSED: t("homeArchiveRefused"),
  }
  const currentSnapshot = snapshotForDraft(draft)
  const currentScope = `${page._id}:${currentLocale}`
  const [savedBaseline] = useState(() => {
    const baseline =
      retainedSaveBase?.locale === currentLocale
        ? retainedSaveBase.snapshot
        : savedBaselineSnapshot(page, defaultLocale, currentLocale)
    return retainedSharedDraft
      ? snapshotForDraft({
          ...JSON.parse(baseline),
          ...retainedSharedDraft.baseline,
        })
      : baseline
  })
  const sharedBaselineRef = useRef(
    sharedDraftValues(JSON.parse(savedBaseline) as PageSaveDraft)
  )
  const lastSavedRef = useRef<string>(savedBaseline)
  const savedSnapshotsRef = useRef(
    new Map([
      [currentScope, savedBaseline],
      ...(retainedSaveBase
        ? [
            [
              `${page._id}:${retainedSaveBase.locale}`,
              retainedSaveBase.snapshot,
            ] as const,
          ]
        : []),
    ])
  )
  // Storage keys can recur; actions belong only to this generation of the key.
  const scopeRef = useRef<{
    key: string | typeof UNMOUNTED_SCOPE
    generation: number
  }>({ key: currentScope, generation: 0 })
  function isCurrentScope(submittedScope: EditorScope) {
    return (
      scopeRef.current.key === submittedScope.key &&
      scopeRef.current.generation === submittedScope.generation
    )
  }
  function captureEditorScope(): () => boolean {
    const submittedScope = {
      key: currentScope,
      generation: scopeRef.current.generation,
    }
    return () => isCurrentScope(submittedScope)
  }
  // Locale lifetimes may expire while their page still needs reconciliation.
  // The existing scope owner also records unmount; no second lifetime counter.
  function isEditorPageMounted() {
    return (
      typeof scopeRef.current.key === "string" &&
      scopeRef.current.key.startsWith(`${page._id}:`)
    )
  }
  const persistedBaseSlugRef = useRef(page.slug ?? "")
  const persistedLocalizedSlugsRef = useRef({ ...page.localizedSlugs })
  const saveInFlightRef = useRef<Promise<boolean> | null>(null)
  const [hasUnsaved, setHasUnsaved] = useState(
    savedBaseline !== currentSnapshot
  )
  const [isSaving, setIsSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  // ADR-0041 §4 — two OCC tokens:
  //   * `knownStagingUpdatedAtRef` guards `updateDraft` against a
  //     racing writer on the SAME staging row (lock-eviction case).
  //     Undefined = lazy-create (`assertStagingFresh` short-circuits).
  //     Publish/discard clear it so the next save rebuilds from
  //     scratch (§4 "autosave rebuilds fresh staging").
  //   * `knownPageUpdatedAtRef` guards the residual `pages.update`
  //     calls (hierarchy, pageType, status transitions).
  //     Collapsing them into one token would produce spurious
  //     "someone took over" errors on independent writes.
  const knownStagingUpdatedAtRef = useRef<number | undefined>(
    retainedSharedDraft
      ? retainedSharedDraft.saveBase.stagingUpdatedAt
      : initialStagingUpdatedAt
  )
  const knownPageUpdatedAtRef = useRef(
    retainedSharedDraft?.saveBase.pageUpdatedAt ?? page.updatedAt
  )
  const [hasStaging, setHasStaging] = useState(initialHasStaging)
  const adoptionReports = useRef<TitleWriteReport[]>(
    draft.removedTitleLinks ?? []
  )
  const draftRef = useRef(draft)
  useEffect(() => {
    draftRef.current = draft
  })
  const [recoveryDraft, setRecoveryDraftValue] =
    useState<PageEditorRecoveryDraft | null>(() => {
      // This buffer survived the History remount in retainedDrafts. Its copy
      // stays in storage, but there is no unresolved recovery to adopt again.
      if (
        retainedSaveBase?.locale === currentLocale ||
        retainedSharedDraft?.saveBase.locale === currentLocale
      )
        return null
      const recovered = readRecoveryDraft(page._id, currentLocale)
      return recovered && recovered.savedAt > page.updatedAt ? recovered : null
    })

  const unresolvedRecoveryRef = useRef(recoveryDraft)
  // An action refused because the recovered draft waits for Restore or
  // Discard; the editor shows the refusal inside the recovery bar until then.
  const [recoveryRefused, setRecoveryRefused] = useState(false)
  function setRecoveryDraft(value: PageEditorRecoveryDraft | null) {
    unresolvedRecoveryRef.current = value
    setRecoveryDraftValue(value)
    setRecoveryRefused(false)
  }
  function refuseForRecovery() {
    setRecoveryRefused(true)
  }

  function rememberUpdatedAt(updatedAt: number) {
    knownPageUpdatedAtRef.current = Math.max(
      knownPageUpdatedAtRef.current,
      updatedAt
    )
  }

  function clearRecoveryDraftState() {
    clearRecoveryDraft(page._id, currentLocale)
    setRecoveryDraft(null)
  }

  function savedSnapshotForLocale(locale: Locale) {
    return (
      savedSnapshotsRef.current.get(`${page._id}:${locale}`) ??
      snapshotForDraft({
        ...JSON.parse(savedBaselineSnapshot(page, defaultLocale, locale)),
        ...sharedBaselineRef.current,
      })
    )
  }

  function hasUnsavedLocaleDraft(
    locale: Locale,
    localizedDraft: Partial<PageSaveDraft>
  ) {
    return (
      snapshotForDraft({ ...draftRef.current, ...localizedDraft }) !==
      savedSnapshotForLocale(locale)
    )
  }

  function captureSaveBase(locale: Locale): RetainedPageSaveBase {
    if (retainedSaveBase?.locale === locale) return retainedSaveBase
    return {
      locale,
      snapshot: savedSnapshotForLocale(locale),
      stagingUpdatedAt: knownStagingUpdatedAtRef.current,
      pageUpdatedAt: knownPageUpdatedAtRef.current,
    }
  }

  // Shared edits have one baseline across locale switches. Retain the same
  // values projection and its saved authority; a refreshed route is not a Save.
  function hasUnsavedSharedDraft(values: SharedDraftValues): boolean {
    return (
      JSON.stringify(sharedDraftValues(values)) !==
      JSON.stringify(sharedBaselineRef.current)
    )
  }

  function captureSharedDraft(
    saveBase: RetainedPageSaveBase
  ): RetainedSharedPageSaveDraft | undefined {
    const values = sharedDraftValues(draftRef.current)
    if (JSON.stringify(values) === JSON.stringify(sharedBaselineRef.current))
      return undefined
    return {
      values,
      refusalBase: getSharedRefusalBase?.(),
      baseline: sharedBaselineRef.current,
      saveBase: {
        ...saveBase,
        locale: currentLocale,
        snapshot: savedSnapshotForLocale(currentLocale),
      },
    }
  }

  function discardRecoveryDraft() {
    clearRecoveryDraftState()
    toast.success(t("recoveryDiscarded"))
  }

  useEffect(() => {
    // StrictMode replay resumes this scope without adopting our cleanup's recovery.
    if (scopeRef.current.key === UNMOUNTED_SCOPE)
      scopeRef.current = { ...scopeRef.current, key: currentScope }
    if (scopeRef.current.key !== currentScope) {
      scopeRef.current = {
        key: currentScope,
        generation: scopeRef.current.generation + 1,
      }
      const baseline =
        savedSnapshotsRef.current.get(currentScope) ??
        snapshotForDraft({
          ...JSON.parse(
            savedBaselineSnapshot(page, defaultLocale, currentLocale)
          ),
          ...sharedBaselineRef.current,
        })
      savedSnapshotsRef.current.set(currentScope, baseline)
      lastSavedRef.current = baseline
      const recovered = readRecoveryDraft(page._id, currentLocale)
      setRecoveryDraft(
        retainedSaveBase?.locale !== currentLocale &&
          retainedSharedDraft?.saveBase.locale !== currentLocale &&
          recovered &&
          recovered.savedAt > page.updatedAt
          ? recovered
          : null
      )
      setSavedAt(null)
    }
    setHasUnsaved(currentSnapshot !== lastSavedRef.current)
  }, [
    currentScope,
    currentSnapshot,
    currentLocale,
    defaultLocale,
    initialHasStaging,
    initialStagingUpdatedAt,
    page,
    retainedSaveBase,
    retainedSharedDraft,
  ])

  useEffect(() => {
    if (!retainedSharedDraft) rememberUpdatedAt(page.updatedAt)
  }, [page.updatedAt, retainedSharedDraft])

  const recoveryBaseReader = useRef(getRecoveryBase)
  useLayoutEffect(() => {
    recoveryBaseReader.current = getRecoveryBase
  })
  function recoveryBase(locale: Locale): RecoveryBase | null {
    return recoveryBaseReader.current?.(locale) ?? null
  }

  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRecovery = useRef<{
    scope: string
    pageId: Id<"pages">
    locale: Locale
    draft: PageSaveDraft
    base: RecoveryBase | null
    dirty: boolean
    blocked: boolean
  } | null>(null)
  const flushRecoveryRef = useRef(() => {})
  // The parent passes a new callback every render; read the newest through a
  // ref so the recovery effect below does not re-run (and re-validate the
  // whole page) on every keystroke.
  const recoveryDraftForFlushRef = useRef(recoveryDraftForFlush)
  useLayoutEffect(() => {
    recoveryDraftForFlushRef.current = recoveryDraftForFlush
  })
  // Install before lifecycle events; the getter reads input received even
  // before the next React render into the parent's synchronous draft refs.
  useLayoutEffect(() => {
    flushRecoveryRef.current = () => {
      const latest =
        recoveryDraftForFlushRef.current?.(draftRef.current) ?? draftRef.current
      if (
        scopeRef.current.key !== currentScope ||
        unresolvedRecoveryRef.current ||
        (snapshotForDraft(latest) === lastSavedRef.current &&
          !latest.inlineConflicts?.length)
      )
        return
      writeRecoveryDraft(page._id, {
        savedAt: Date.now(),
        locale: currentLocale,
        ...latest,
        base: recoveryBase(currentLocale),
      })
    }
  })
  useEffect(() => {
    const old = pendingRecovery.current
    if (old && old.scope !== currentScope && old.dirty && !old.blocked)
      writeRecoveryDraft(old.pageId, {
        savedAt: Date.now(),
        locale: old.locale,
        ...old.draft,
        base: old.base,
      })
    pendingRecovery.current = {
      scope: currentScope,
      pageId: page._id,
      locale: currentLocale,
      draft:
        recoveryDraftForFlushRef.current?.(draftRef.current) ??
        draftRef.current,
      dirty: currentSnapshot !== lastSavedRef.current,
      base: recoveryBase(currentLocale),
      blocked: Boolean(unresolvedRecoveryRef.current),
    }
    if (recoveryTimer.current === null)
      recoveryTimer.current = setTimeout(() => {
        recoveryTimer.current = null
        flushRecoveryRef.current()
      }, 250)
  }, [
    currentScope,
    page._id,
    currentLocale,
    currentSnapshot,
    recoveryDraft,
    draft.inlineConflicts,
    // Save moves `lastSavedRef` without changing the snapshot; `hasUnsaved`
    // is the state that changes with it, so `dirty` below stays current.
    hasUnsaved,
  ])
  useEffect(() => {
    const flush = () => flushRecoveryRef.current()
    const visibility = () => {
      if (document.visibilityState === "hidden") flush()
    }
    window.addEventListener("pagehide", flush)
    document.addEventListener("visibilitychange", visibility)
    return () => {
      flush()
      scopeRef.current = {
        key: UNMOUNTED_SCOPE,
        generation: scopeRef.current.generation + 1,
      }
      if (recoveryTimer.current !== null) clearTimeout(recoveryTimer.current)
      recoveryTimer.current = null
      window.removeEventListener("pagehide", flush)
      document.removeEventListener("visibilitychange", visibility)
    }
  }, [])

  async function persistSave(
    draft: PageSaveDraft,
    currentSnapshot: string,
    submittedScope: EditorScope,
    persistedDraft: PageSaveDraft,
    expectedPresentationCatalogRevision: string | undefined
  ): Promise<boolean> {
    const addressWriteCount = getDraftWriteCount?.()
    let savedSnapshot = currentSnapshot
    return tryOrElse(
      async () => {
        // History already replaced this draft on the server. Its old base must
        // reach the usual conflict flow even when the old staging token was
        // undefined (the legacy command treats that as an unchecked lazy-create).
        if (
          (retainedSaveBase?.locale === currentLocale || retainedSharedDraft) &&
          recoveryBase(currentLocale)?.lifecycleGeneration !== -1
        )
          throw new Error(staleSaveMessage)
        // Renew the lock first — see `refreshEditorLock` for why. A `false`
        // result means someone else holds it; bail before writing anything so
        // the user gets the take-over flow instead of a mid-save failure.
        if (!(await refreshEditorLock())) {
          if (isCurrentScope(submittedScope)) toast.error(t("saveFailed"))
          return false
        }
        if (!isCurrentScope(submittedScope)) return false
        if (refuseAddress?.()) return false
        let desired = draft.slug.trim()
        // C8: single descriptor-shaped bag replaces the old {title, metaTitle,
        // metaDescription, slices} flat args. `pageType` is stored-immutable
        // (C1); the client sends the arm matching the current stored type so
        // the mutation's cross-arm guard is satisfied.
        // Descriptor-generic localized values (author roleTitle/bio today; more
        // as descriptors grow) merge with the system-owned title/meta. The
        // system-owned keys go LAST so a tampered / stale-recovered bag
        // carrying a `title` (or metaTitle/metaDescription) can never clobber
        // the visible editor state — defense in depth for the case where
        // `extractLocalizedFieldValues` didn't run through its ownership filter.
        // Pure-form arms (`sliceBody: false`) have no slice canvas, so the
        // discriminated `contentDraftInputValidator` arm for those types has
        // no `slices` field at all (e.g. testimonial — plan 029 C10 task 13).
        // Their localized bag is descriptor-shaped only — no `metaTitle` /
        // `metaDescription` since pure-form types don't participate in SEO
        // meta (non-routable), and sending those keys would fail the arm's
        // strict-object validation server-side. Slice-body arms merge the
        // system-owned title/meta LAST so a tampered / stale-recovered bag
        // carrying a `title` (or metaTitle/metaDescription) can never clobber
        // the visible editor state.
        const contentDraft = hasSliceBody(page)
          ? {
              pageType: page.pageType,
              localized: {
                ...draft.localizedFieldValues,
                title: draft.title,
                metaTitle: draft.metaTitle || undefined,
                metaDescription: draft.metaDescription || undefined,
              },
              slices: draft.slices,
            }
          : {
              pageType: page.pageType,
              localized: {
                ...draft.localizedFieldValues,
                title: draft.title,
              },
            }

        const typeChanged = draft.pageType !== persistedDraft.pageType
        const currentParent = persistedDraft.parentId
        const parentChanged = draft.parentId !== currentParent
        // Plan 029 C8/C9a — descriptor shared-field values (author `name` /
        // `socials`, post `category`, and any future non-system-owned shared
        // field) flow through `updateDraft` alongside the bespoke authorIds /
        // tags handling. The ownership map keeps `authorIds` / `tags` out of
        // `draft.sharedFieldValues` so we don't double-write them.
        //
        // C9a fixes two C8 traps at once:
        //
        // 1. **Cleared field is a no-op.** Convex serializes `undefined` args
        //    as omitted, so a bag key that transitioned to empty via the
        //    generic panel would spread as `{key: undefined}` — omitted — and
        //    the server never entered its `!== undefined` clear branch. UI
        //    read "Saved", DB unchanged. Fix: emit `null` (Convex-serializable
        //    clear signal, per widened args) whenever the value has semantic
        //    emptiness AND the descriptor says the field is optional.
        // 2. **Order-sensitive/undef-vs-null diff.** `JSON.stringify(x ?? null)`
        //    collapsed `undefined`↔`null` into the same bucket (a clear
        //    transition never fired) and was key-order-sensitive on nested
        //    groups. Fix: normalize by `isPrimitiveValueEmpty` first so
        //    empty-vs-empty is always equal regardless of shape, then compare
        //    the non-empty tail with JSON — safe for scalar/list-of-groups
        //    today; a nested-group shape will want a structural walker.
        //
        // Compare with the last accepted saved draft, not route props: a user
        // can save again before router.refresh delivers the previous write.
        const storedShared = persistedDraft.sharedFieldValues
        const sharedFieldDefs = adminContentTypeSharedFields(page.pageType)
        const changedSharedFields: Record<string, unknown> = {}
        for (const [key, next] of Object.entries(draft.sharedFieldValues)) {
          if (SYSTEM_OWNED_SHARED_FIELDS.has(key)) continue
          const def = (sharedFieldDefs as Record<string, Primitive>)[key]
          if (!def) continue
          const current = storedShared[key]
          const currentEmpty = isPrimitiveValueEmpty(def, current)
          const nextEmpty = isPrimitiveValueEmpty(def, next)
          if (currentEmpty && nextEmpty) continue
          if (
            !currentEmpty &&
            !nextEmpty &&
            JSON.stringify(current) === JSON.stringify(next)
          ) {
            continue
          }
          const isOptional = def.validator.isOptional === "optional"
          changedSharedFields[key] = nextEmpty && isOptional ? null : next
        }
        const sharedFieldsChanged = Object.keys(changedSharedFields).length > 0
        // `authorIds` + `tags` live only on the `post` arm of the pages union
        // (plan 028 C1). Non-post pages have no current author/tags to compare
        // against — the draft simply carries what the user entered.
        const currentAuthorIds = persistedDraft.authorIds
        const authorsChanged =
          JSON.stringify(draft.authorIds) !== JSON.stringify(currentAuthorIds)
        const currentTags = persistedDraft.tags
        // Only posts declare `tags`; the server refuses the key elsewhere.
        const tagsChanged =
          page.pageType === "post" &&
          (draft.tags.length !== currentTags.length ||
            draft.tags.some((tag, index) => tag !== currentTags[index]))
        const seo: Record<string, unknown> = { ...(page.seo ?? {}) }
        const setOrDel = (key: string, value: unknown) => {
          if (value) seo[key] = value
          else delete seo[key]
        }
        setOrDel("noIndex", draft.seoNoIndex)
        setOrDel("noFollow", draft.seoNoFollow)
        setOrDel("ogTitle", draft.seoOgTitle.trim())
        setOrDel("ogDescription", draft.seoOgDescription.trim())
        setOrDel("ogImage", draft.seoOgImage.trim())
        const persistedSeo: Record<string, unknown> = { ...(page.seo ?? {}) }
        const savedSeoValues = {
          noIndex: persistedDraft.seoNoIndex,
          noFollow: persistedDraft.seoNoFollow,
          ogTitle: persistedDraft.seoOgTitle.trim(),
          ogDescription: persistedDraft.seoOgDescription.trim(),
          ogImage: persistedDraft.seoOgImage.trim(),
        }
        for (const [key, value] of Object.entries(savedSeoValues)) {
          if (value) persistedSeo[key] = value
          else delete persistedSeo[key]
        }
        const seoChanged = JSON.stringify(seo) !== JSON.stringify(persistedSeo)

        // Slug delta — per-locale behavior: editing on the default locale
        // writes the base `slug`; editing on any other locale writes/clears
        // an entry in `localizedSlugs`. Staging replaces `localizedSlugs`
        // wholesale on save, so we build the full next bag from the
        // current one plus this locale's edit.
        const currentBaseSlug = persistedBaseSlugRef.current
        const currentLocalizedSlugs = persistedLocalizedSlugsRef.current
        let stagedSlug: string | undefined
        let stagedLocalizedSlugs: Record<string, string> | undefined
        if (currentLocale === defaultLocale) {
          if (desired && desired !== currentBaseSlug) {
            stagedSlug = desired
          }
        } else {
          const before = currentLocalizedSlugs[currentLocale]
          const nextBag = { ...currentLocalizedSlugs }
          if (!desired || desired === currentBaseSlug) {
            if (before !== undefined) delete nextBag[currentLocale]
          } else {
            nextBag[currentLocale] = desired
          }
          const beforeJson = JSON.stringify(currentLocalizedSlugs)
          const nextJson = JSON.stringify(nextBag)
          if (beforeJson !== nextJson) stagedLocalizedSlugs = nextBag
        }
        const slugChanged =
          stagedSlug !== undefined || stagedLocalizedSlugs !== undefined

        // ── updateDraft (staging write) ─────────────────────────────────
        // Everything the ADR §1 stages routes through this one call.
        //
        // The `updatePage` call below handles the strictly-live fields
        // (hierarchy, pageType).
        //
        // Gate the call on ACTUAL staged-field change. Firing updateDraft
        // for every save (e.g. a hierarchy-only edit) would create a
        // byte-identical staging row and raise "Unpublished changes,"
        // nagging a publish of nothing — a Deploy-1-to-Deploy-2 regression
        // vs. the pre-cutover no-badge behaviour. Content-change detection
        // compares the composed bag against `page.content[currentLocale]`
        // (which is already the overlaid view via `getForEdit`).
        const priorLocaleBag = {
          ...persistedDraft.localizedFieldValues,
          title: persistedDraft.title,
          ...(hasSliceBody(page)
            ? {
                metaTitle: persistedDraft.metaTitle || undefined,
                metaDescription: persistedDraft.metaDescription || undefined,
                slices: persistedDraft.slices,
              }
            : {}),
        } as Record<string, unknown>
        const contentActuallyChanged =
          JSON.stringify(contentDraft.localized) !==
            JSON.stringify({
              ...(priorLocaleBag ?? {}),
              // Drop `slices` from the comparison of `localized` — slices
              // are compared separately below and live outside the
              // descriptor-localized bag on `contentDraft`.
              slices: undefined,
            }) ||
          JSON.stringify(
            (contentDraft as { slices?: unknown }).slices ?? undefined
          ) !== JSON.stringify(priorLocaleBag?.slices ?? undefined)
        const anyStagedChange =
          contentActuallyChanged ||
          stagedSlug !== undefined ||
          stagedLocalizedSlugs !== undefined ||
          seoChanged ||
          authorsChanged ||
          tagsChanged ||
          sharedFieldsChanged

        if (saveSnapshotDraft && typeChanged) {
          toast.error(t("contentTypeChangeUnavailable"))
          return false
        }

        const localizedChanged = contentActuallyChanged || slugChanged
        // The server only needs a title/address for a localized write. The lock
        // refresh above already ran (it precedes the delta computation, and a
        // refused save leaves it harmlessly renewed); nothing is written yet.
        // Clearing the default locale's saved address is not a slug delta (a
        // blank `desired` is ignored above), so it is asked about separately.
        // It only widens the refusal check: nothing is written for it.
        const defaultAddressCleared =
          currentLocale === defaultLocale &&
          desired === "" &&
          currentBaseSlug.trim() !== ""
        if (
          (localizedChanged || defaultAddressCleared) &&
          refuseDraft?.(draft, {
            snapshot: Boolean(saveSnapshotDraft),
            addressCleared: defaultAddressCleared,
          })
        )
          return false
        const sharedChanged =
          seoChanged ||
          authorsChanged ||
          tagsChanged ||
          sharedFieldsChanged ||
          parentChanged

        if (saveSnapshotDraft && (localizedChanged || sharedChanged)) {
          const addressResult = await saveSnapshotDraft({
            ...(expectedPresentationCatalogRevision
              ? { expectedPresentationCatalogRevision }
              : {}),
            ...(localizedChanged
              ? {
                  localized: {
                    locale: currentLocale,
                    slug: desired,
                    ...(addressIntent
                      ? { addressIntent: addressIntent() }
                      : {}),
                    draft: contentDraft as never,
                  },
                }
              : {}),
            ...(sharedChanged
              ? {
                  shared: {
                    ...(seoChanged ? { seo: seo as never } : {}),
                    ...(authorsChanged ? { authorIds: draft.authorIds } : {}),
                    ...(tagsChanged ? { tags: draft.tags } : {}),
                    ...(sharedFieldsChanged
                      ? {
                          sharedFieldsJson: JSON.stringify(changedSharedFields),
                        }
                      : {}),
                    ...(parentChanged && draft.parentId
                      ? { parentId: draft.parentId as Id<"pages"> }
                      : {}),
                    ...(parentChanged && !draft.parentId
                      ? { clearParent: true }
                      : {}),
                  },
                }
              : {}),
          })
          if (!isCurrentScope(submittedScope)) return false
          if (addressResult.slug && addressResult.slug !== desired) {
            if (
              draftRef.current.slug === desired &&
              getDraftWriteCount?.() === addressWriteCount
            ) {
              onAddressAllocated?.(addressResult.slug, desired)
              draftRef.current = {
                ...draftRef.current,
                slug: addressResult.slug,
              }
            }
            desired = addressResult.slug
            draft = { ...draft, slug: desired }
            savedSnapshot = snapshotForDraft(draft)
          }
          setHasStaging(true)
        }

        if (!saveSnapshotDraft && anyStagedChange) {
          type UpdateDraftArgs = FunctionArgs<typeof api.cms.pages.updateDraft>
          const updateDraftArgs: UpdateDraftArgs = {
            pageId: page._id,
            expectedUpdatedAt: knownStagingUpdatedAtRef.current,
            ...(expectedPresentationCatalogRevision
              ? { expectedPresentationCatalogRevision }
              : {}),
          }
          if (contentActuallyChanged) {
            const contentRecord = {
              [currentLocale]: contentDraft,
            } as unknown as UpdateDraftArgs["content"]
            updateDraftArgs.content = contentRecord
          }
          if (stagedSlug !== undefined) updateDraftArgs.slug = stagedSlug
          if (stagedLocalizedSlugs !== undefined)
            updateDraftArgs.localizedSlugs = stagedLocalizedSlugs
          if (seoChanged)
            updateDraftArgs.seo = seo as FunctionArgs<
              typeof api.cms.pages.updateDraft
            >["seo"]
          if (authorsChanged) updateDraftArgs.authorIds = draft.authorIds
          if (tagsChanged) updateDraftArgs.tags = draft.tags
          if (sharedFieldsChanged) {
            updateDraftArgs.sharedFieldsJson =
              JSON.stringify(changedSharedFields)
          }

          const draftResult = await updateDraft(updateDraftArgs)
          knownStagingUpdatedAtRef.current = draftResult.updatedAt
          if (!isCurrentScope(submittedScope)) return false
          setHasStaging(true)
        }

        if (stagedSlug !== undefined) persistedBaseSlugRef.current = stagedSlug
        if (stagedLocalizedSlugs !== undefined)
          persistedLocalizedSlugsRef.current = stagedLocalizedSlugs
        setSavedSlugByLocale((prev) => {
          const next = { ...prev }
          const base = next[defaultLocale] ?? page.slug ?? ""
          if (currentLocale === defaultLocale) {
            if (desired) next[defaultLocale] = desired
          } else if (!desired || desired === base) {
            delete next[currentLocale]
          } else {
            next[currentLocale] = desired
          }
          return next
        })

        // ── pages.update (live-immediate write) ─────────────────────────
        // Hierarchy, pageType — none staged per ADR §1. Runs after
        // `updateDraft` so a hierarchy failure does not orphan a successful
        // staged write.
        if (!saveSnapshotDraft && (typeChanged || parentChanged)) {
          const pageResult = await updatePage({
            id: page._id,
            pageType: typeChanged ? draft.pageType : undefined,
            parentId:
              parentChanged && draft.parentId
                ? (draft.parentId as Id<"pages">)
                : undefined,
            clearParent: parentChanged && !draft.parentId ? true : undefined,
            expectedUpdatedAt: knownPageUpdatedAtRef.current,
          })
          if (!isCurrentScope(submittedScope)) return false
          rememberUpdatedAt(pageResult.updatedAt)
          if (pageResult.staged) setHasStaging(true)
        }

        // Silence unused warning — the pieces are consumed in the
        // deltas above; the flat booleans are also used to gate the
        // downstream call.
        void slugChanged
        void sharedFieldsChanged

        // Shared fields have one persistence scope, even while each locale
        // retains its own saved content baseline.
        sharedBaselineRef.current = sharedDraftValues(draft)
        for (const [scope, baseline] of savedSnapshotsRef.current) {
          savedSnapshotsRef.current.set(
            scope,
            snapshotForDraft({
              ...JSON.parse(baseline),
              ...sharedBaselineRef.current,
            })
          )
        }
        lastSavedRef.current = savedSnapshot
        savedSnapshotsRef.current.set(submittedScope.key, savedSnapshot)
        const hasNewerEdit =
          snapshotForDraft(draftRef.current) !== savedSnapshot
        setSavedAt(new Date())
        setHasUnsaved(hasNewerEdit)
        if (!unresolvedRecoveryRef.current && !hasNewerEdit)
          clearRecoveryDraftState()
        else if (!unresolvedRecoveryRef.current) {
          setRecoveryDraft(null)
          writeRecoveryDraft(page._id, {
            savedAt: Date.now(),
            locale: currentLocale,
            ...draftRef.current,
            base: recoveryBase(currentLocale),
          })
        }
        toast.success(t("saved"))
        router.refresh()
        return true
      },
      async (err) => {
        if (!isCurrentScope(submittedScope)) return false
        if (isStaleSaveError(err)) {
          // A concurrent write can be newer than the buffer's last edit. Refresh
          // its recovery timestamp before offering reload, keeping later typing.
          if (!unresolvedRecoveryRef.current) {
            writeRecoveryDraft(page._id, {
              savedAt: Date.now(),
              locale: currentLocale,
              ...draftRef.current,
              base: recoveryBase(currentLocale),
            })
          }
          toast.error(t("changedElsewhere"))
          await onSaveConflict()
          return false
        }
        toast.error(
          pageSaveErrorMessage(
            err,
            addressMessages.save(err, displayError(err, t("saveFailed"))),
            publicationErrorMessages
          )
        )
        return false
      }
    )
  }

  function save(): Promise<boolean> {
    if (unresolvedRecoveryRef.current) {
      refuseForRecovery()
      return Promise.resolve(false)
    }
    if (saveInFlightRef.current) return saveInFlightRef.current
    const submittedScope = {
      key: currentScope,
      generation: scopeRef.current.generation,
    }
    const initialSnapshot = snapshotForDraft(draftRef.current)
    const isCurrent = () =>
      isCurrentScope(submittedScope) &&
      !unresolvedRecoveryRef.current &&
      snapshotForDraft(draftRef.current) === initialSnapshot
    const captured = captureDraft ? captureDraft(draft, isCurrent) : draft
    // Sampled after the synchronous part of the capture: writes made by the
    // capture itself (an inline flush) belong to it; later ones are newer.
    const writesAtCapture = getDraftWriteCount?.()
    const persistCaptured = (value: PageSaveDraft | null) => {
      if (!value || !isCurrentScope(submittedScope))
        return Promise.resolve(false)
      if (unresolvedRecoveryRef.current) {
        refuseForRecovery()
        return Promise.resolve(false)
      }
      // A capture that resolves after newer typing must not replace it: its
      // value is older than the buffer, and a save would delete the buffer's
      // recovery copy. `draftRef` follows renders; the write count does not.
      if (
        captured instanceof Promise &&
        (!isCurrent() || getDraftWriteCount?.() !== writesAtCapture)
      )
        return Promise.resolve(false)
      const adopted = adoptHeroTitles(
        value.slices,
        currentLocale,
        value.removedTitleLinks ?? adoptionReports.current,
        true
      )
      adoptionReports.current = adopted.reports
      value = {
        ...value,
        slices: adopted.value,
        removedTitleLinks: adopted.reports,
        sharedFieldValues: writeFieldMap(
          adminContentTypeSharedFields(value.pageType),
          value.sharedFieldValues
        ),
        localizedFieldValues: writeFieldMap(
          adminContentTypeLocalizedFields(value.pageType),
          value.localizedFieldValues
        ),
      }
      onPreparedDraft?.(value)
      draftRef.current = value
      const snapshot = snapshotForDraft(value)
      if (snapshot === lastSavedRef.current) return Promise.resolve(true)
      return persistSave(
        value,
        snapshot,
        submittedScope,
        JSON.parse(lastSavedRef.current) as PageSaveDraft,
        presentationCatalogRevision
      )
    }
    if (!(captured instanceof Promise) && !captured)
      return Promise.resolve(false)
    setIsSaving(true)
    const pending = (
      captured instanceof Promise
        ? captured.then(persistCaptured)
        : persistCaptured(captured)
    ).finally(() => {
      saveInFlightRef.current = null
      setIsSaving(false)
    })
    saveInFlightRef.current = pending
    return pending
  }

  async function ensureSaved(): Promise<boolean> {
    // Even a clean base can have an active buffer whose final event has not
    // reached a React render. Capture it before deciding that Save is a no-op.
    if (
      !unresolvedRecoveryRef.current &&
      !captureDraft &&
      !hasUnsaved &&
      !saveInFlightRef.current
    )
      return true
    return save()
  }

  async function publish() {
    const submittedScope = {
      key: currentScope,
      generation: scopeRef.current.generation,
    }
    if (!(await ensureSaved())) return
    if (unresolvedRecoveryRef.current) return refuseForRecovery()
    if (!isCurrentScope(submittedScope)) return
    if (snapshotForDraft(draftRef.current) !== lastSavedRef.current) return
    if (!(await confirmPrePublishReadiness())) return
    if (unresolvedRecoveryRef.current) return refuseForRecovery()
    if (!isCurrentScope(submittedScope)) return
    if (snapshotForDraft(draftRef.current) !== lastSavedRef.current) return
    try {
      // ADR-0041 §3 — publish is the make-live verb. No `expectedUpdatedAt`
      // (reviewers may publish out from under an in-flight editor per §4).
      const result = await publishPage({ pageId: page._id })
      let stale = !isCurrentScope(submittedScope)
      rememberUpdatedAt(result.updatedAt)
      // Publish consumed the staging row (§9 path 1) — next autosave
      // lazy-creates a fresh one.
      knownStagingUpdatedAtRef.current = undefined
      if (!stale) setHasStaging(false)
      await revalidatePagePaths(page._id)
      stale = !isCurrentScope(submittedScope)
      if (stale) return
      toast.success(t("published"))
      router.refresh()
    } catch (err) {
      if (!isCurrentScope(submittedScope)) return
      toast.error(
        pageSaveErrorMessage(
          err,
          addressMessages.publish(
            err,
            displayError(err, t("publishFailed")),
            page.pageType,
            true
          ),
          publicationErrorMessages
        )
      )
    }
  }

  async function discard() {
    const discardStartedAt = Date.now()
    const submittedScope = {
      key: currentScope,
      generation: scopeRef.current.generation,
    }
    if (!hasStaging) return
    // ADR-0041 §9 — Discard confirmation & toast copy.
    //
    // After Deploy 2 PR B item 3, discarding a never-published draft
    // deletes the only copy of its content (staging is authoritative;
    // `pages.content` is empty). Discarding a published page's staging
    // still reverts to the last-published snapshot on `pages.content`.
    // The toast has to describe whichever outcome actually happened.
    const kind: "published" | "never-published" =
      page.publishedAt !== undefined ? "published" : "never-published"
    const ok = await confirmDiscard(kind)
    const stale = !isCurrentScope(submittedScope)
    if (stale || !ok) return
    await tryOrElse(
      async () => {
        await discardDraft({ pageId: page._id })
        const stale = !isCurrentScope(submittedScope)
        if (stale) {
          // The same storage key can already hold typing from a later lifetime.
          const recovery = readRecoveryDraft(page._id, currentLocale)
          if (!recovery || recovery.savedAt <= discardStartedAt)
            clearRecoveryDraft(page._id, currentLocale)
          return
        }
        knownStagingUpdatedAtRef.current = undefined
        setHasStaging(false)
        // Discard invalidates any in-memory unsaved-change tracking —
        // reload the editor from the server rather than leaving the
        // dirty state stuck.
        lastSavedRef.current = ""
        setHasUnsaved(false)
        clearRecoveryDraftState()
        toast.success(
          kind === "never-published"
            ? t("allContentRemoved")
            : t("revertedToPublished")
        )
        // ADR-0041 Deploy 2 PR B item 3 — the editor's local state (title,
        // slices, shared/localized bags) is initialised from the server
        // props at mount. `router.refresh()` re-runs the server components
        // but leaves the client component's `useState` values in place, so
        // the header/preview keep displaying the pre-discard content until
        // the tab is manually reloaded. Force a full reload so what the
        // editor renders matches what the DB now holds.
        if (typeof window !== "undefined") {
          window.location.reload()
        } else {
          router.refresh()
        }
      },
      (err) => {
        if (!isCurrentScope(submittedScope)) return
        toast.error(
          pageSaveErrorMessage(
            err,
            displayError(err, t("discardFailed")),
            publicationErrorMessages
          )
        )
      }
    )
  }

  async function updateStatus(
    status: "draft" | "archived",
    successMessage: string,
    failureMessage: string
  ) {
    const submittedScope = {
      key: currentScope,
      generation: scopeRef.current.generation,
    }
    try {
      const result = await updatePage({
        id: page._id,
        status,
        expectedUpdatedAt: knownPageUpdatedAtRef.current,
      })
      let stale = !isCurrentScope(submittedScope)
      rememberUpdatedAt(result.updatedAt)
      await revalidatePagePaths(page._id)
      stale = !isCurrentScope(submittedScope)
      if (stale) return
      toast.success(successMessage)
      router.refresh()
    } catch (err) {
      if (!isCurrentScope(submittedScope)) return
      toast.error(
        pageSaveErrorMessage(
          err,
          displayError(err, failureMessage),
          publicationErrorMessages
        )
      )
    }
  }

  return {
    titleAdoptionReports: adoptionReports,
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
    save,
    ensureSaved,
    publish,
    discard,
    unpublish: () =>
      updateStatus("draft", t("unpublished"), t("unpublishFailed")),
    archive: () => updateStatus("archived", t("archived"), t("archiveFailed")),
    unarchive: () =>
      updateStatus("draft", t("restoredToDraft"), t("restoreFailed")),
  }
}
