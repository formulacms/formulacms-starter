"use client"

import {
  Component,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  useConvexAuth,
  useQueries,
  useQuery,
  type RequestForQueries,
} from "convex/react"
import { api } from "@/convex/_generated/api"
import { PREVIEW_BUILD_ID } from "@/lib/preview-build-id"
import type { Id } from "@/convex/_generated/dataModel"
import type { BlockBodyDoc } from "@/convex/lib/pages/blockBodyContent"
import { postContentType } from "@/convex/lib/contentTypes/post"
import { publicFieldsOf } from "@/convex/lib/contentTypes/exposure"
import type { Block } from "@/convex/lib/blocks"
import type { BlockPresentationCatalog } from "@/convex/lib/blocks/presentationResolution"
import { collectRelationIds } from "@/convex/lib/blocks/resolve"
import {
  getContentTypeRenderer,
  type PublicByline,
} from "@/components/content-types"
import {
  PublicSiteShell,
  type PublicSiteShellProps,
} from "@/components/public/public-site-shell"
import { PresentationLocaleProvider } from "@/components/public/presentation-locale"
import { ThemeProvider } from "@/components/theme-provider"
import { collectPageIds, type BlockRenderContext } from "@/lib/blocks/links"
import {
  applyFreshImageUrls,
  collectImageStorageIds,
} from "@/lib/blocks/media-urls"
import { useTranslations } from "next-intl"
import { PageLivePreviewCanvas } from "./page-live-preview-canvas"
import {
  LIVE_FRAME_SOURCE,
  liveFrameFieldValues,
  sameLiveFrameIdentity,
  validLiveFrameInput,
  type LiveFrameBridge,
  type LiveFrameCallbacks,
  type LiveFrameIdentity,
  type LiveFrameInput,
  type LiveFrameWindow,
} from "./live-preview-frame-bridge"
import { supportsLivePreviewFrame } from "./live-preview-page-type"
import type { PreviewActiveEditHandle } from "./visual-editing-types"

type FrameProps = {
  identity: LiveFrameIdentity
  page: BlockBodyDoc
  config: {
    defaultLocale: string
    enabledLocales: string[]
    languageVersion: number
  }
  shell: Omit<PublicSiteShellProps, "children">
  presentationCatalog?: BlockPresentationCatalog
  /** Anonymous, version-pinned bootstrap path; never an authenticated draft path. */
  publicPath?: string | null
}

/** The private frame has its own root document; its layout provides the
 * authenticated Convex client. */
export function LivePreviewFrameRuntime(props: FrameProps) {
  return <ConnectedLivePreviewFrame {...props} />
}

/** Executes in the child document: its editor, events and selection share a realm. */
function ConnectedLivePreviewFrame({
  identity,
  page,
  config,
  shell,
  presentationCatalog,
  publicPath,
}: FrameProps) {
  const t = useTranslations("editor.livePreview")
  const { sessionId, pageId, locale } = identity
  // One registry owns the renderer per content type; the frame never picks one.
  const renderer = getContentTypeRenderer(page.pageType)
  const BlockBody = renderer.kind === "blockBody" ? renderer.Component : null
  const [input, setInput] = useState<LiveFrameInput | null>(null)
  const inputRef = useRef<LiveFrameInput | null>(null)
  const callbacks = useRef<LiveFrameCallbacks | null>(null)
  const activeHandle = useRef<PreviewActiveEditHandle | null>(null)
  function captureHandle(handle: PreviewActiveEditHandle | null) {
    activeHandle.current = handle
  }
  const enabledLocalesKey = JSON.stringify(config.enabledLocales)

  useEffect(() => {
    const enabledLocales: string[] = JSON.parse(enabledLocalesKey)
    const frameIdentity = { sessionId, pageId, locale }
    const frameWindow = window as LiveFrameWindow
    const generation = crypto.randomUUID()
    let live = true
    let ordered = false
    let draftRevision = -1
    let inputRevision = -1
    const accepts = (next: LiveFrameInput) =>
      live &&
      validLiveFrameInput(next) &&
      next.buildId === PREVIEW_BUILD_ID &&
      sameLiveFrameIdentity(frameIdentity, next) &&
      next.defaultLocale === config.defaultLocale &&
      next.languageVersion === config.languageVersion &&
      enabledLocales.includes(next.locale)
    const acceptsOrdering = (next: LiveFrameInput) =>
      next.ordering
        ? next.ordering.generation === generation &&
          next.ordering.draftRevision >= draftRevision &&
          next.ordering.inputRevision > inputRevision
        : !ordered
    const replaceInput = (next: LiveFrameInput) => {
      if (!accepts(next) || !acceptsOrdering(next)) return false
      if (next.ordering) {
        ordered = true
        draftRevision = next.ordering.draftRevision
        inputRevision = next.ordering.inputRevision
      }
      inputRef.current = next
      setInput(next)
      return true
    }
    const bridge: LiveFrameBridge = {
      ...frameIdentity,
      generation,
      buildId: PREVIEW_BUILD_ID,
      connect(next, nextCallbacks) {
        if (!accepts(next) || !acceptsOrdering(next)) return false
        callbacks.current = nextCallbacks
        nextCallbacks.context(false)
        return replaceInput(next)
      },
      replaceInput,
      acknowledgeDraftRevision(revision) {
        if (
          live &&
          ordered &&
          Number.isSafeInteger(revision) &&
          revision > draftRevision
        )
          draftRevision = revision
      },
      disconnect() {
        if (!live) return
        callbacks.current = null
        inputRef.current = null
        setInput(null)
      },
      flush: () => activeHandle.current?.flush?.(),
      discardActiveEdit: () => {
        if (live) activeHandle.current?.discardActiveEdit?.()
      },
      capture: () => null,
      acceptCapture() {},
      isComposing: () => live && (activeHandle.current?.isComposing() ?? false),
      hasActiveSession: () =>
        live && (activeHandle.current?.hasActiveSession() ?? false),
    }
    frameWindow.__formulacmsLiveFrame = bridge
    const announce = (type: "ready" | "retired" | "unloading") =>
      window.parent.postMessage(
        {
          source: LIVE_FRAME_SOURCE,
          type,
          ...frameIdentity,
          generation,
          buildId: PREVIEW_BUILD_ID,
        },
        window.location.origin
      )
    const hello = (event: MessageEvent) => {
      if (
        event.source === window.parent &&
        event.origin === window.location.origin &&
        event.data?.source === LIVE_FRAME_SOURCE &&
        event.data?.type === "hello" &&
        sameLiveFrameIdentity(event.data, frameIdentity)
      )
        announce("ready")
    }
    const save = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        if (!event.repeat) callbacks.current?.save()
      }
    }
    const pagehide = (event: PageTransitionEvent) => {
      // A BFCache-retained realm resumes with this same bridge and needs no reconnect.
      if (event.persisted) return
      announce("unloading")
      live = false
      callbacks.current = null
      inputRef.current = null
      activeHandle.current = null
    }
    window.addEventListener("message", hello)
    window.addEventListener("keydown", save)
    window.addEventListener("pagehide", pagehide)
    announce("ready")
    return () => {
      announce("retired")
      live = false
      callbacks.current = null
      if (frameWindow.__formulacmsLiveFrame === bridge)
        delete frameWindow.__formulacmsLiveFrame
      window.removeEventListener("message", hello)
      window.removeEventListener("keydown", save)
      window.removeEventListener("pagehide", pagehide)
    }
  }, [
    sessionId,
    pageId,
    locale,
    config.defaultLocale,
    config.languageVersion,
    enabledLocalesKey,
  ])

  if (!input) return <p role="status">{t("frameLoading")}</p>
  return (
    <LiveFrameRenderBoundary
      onError={() => {
        callbacks.current?.context(false)
        callbacks.current?.unavailable()
      }}
      message={t("frameUnavailable")}
    >
      <LiveFrameContext
        input={input}
        presentationCatalog={presentationCatalog}
        onContext={(ready) => callbacks.current?.context(ready)}
        onUnavailable={() => callbacks.current?.unavailable()}
      >
        {(ctx, mediaUrls, ready, bylines) => (
          <PresentationLocaleProvider
            value={{
              locale: input.locale,
              defaultLocale: input.defaultLocale,
              publicPath: ready ? (publicPath ?? null) : null,
            }}
          >
            <ThemeProvider forcedTheme={input.mode}>
              <div
                onClickCapture={(event) => {
                  // Preview chrome is view-only; block interactions are intercepted below.
                  if (
                    event.target instanceof Element &&
                    !event.target.closest("[data-preview-block-occurrence]")
                  ) {
                    event.preventDefault()
                    event.stopPropagation()
                  }
                }}
                onSubmitCapture={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
              >
                <PublicSiteShell {...shell}>
                  <PageLivePreviewCanvas
                    title={input.title}
                    blocks={input.blocks}
                    contentEpoch={input.contentEpoch}
                    inlineEditEcho={input.inlineEditEcho}
                    locale={input.locale}
                    defaultLocale={input.defaultLocale}
                    selectedBlockId={input.selectedBlockId}
                    controlledInlineEnabled={input.inlineEditingEnabled}
                    renderContext={ctx}
                    onSelectBlock={(id) => callbacks.current?.selectBlock(id)}
                    onSelectBlockFallback={(id) =>
                      callbacks.current?.selectBlockFallback?.(id)
                    }
                    onSelectField={(target, result) =>
                      callbacks.current?.selectField(target, result)
                    }
                    onInlineEditCommit={(commit) =>
                      callbacks.current?.commit({
                        ...commit,
                        frameBinding: {
                          sessionId,
                          pageId,
                          generation:
                            (window as LiveFrameWindow).__formulacmsLiveFrame
                              ?.generation ?? "",
                          buildId: PREVIEW_BUILD_ID,
                          languageVersion: input.languageVersion,
                        },
                      })
                    }
                    onActiveEditChange={(commit) => {
                      callbacks.current?.change(
                        commit
                          ? {
                              ...commit,
                              frameBinding: {
                                sessionId,
                                pageId,
                                generation:
                                  (window as LiveFrameWindow)
                                    .__formulacmsLiveFrame?.generation ?? "",
                                buildId: PREVIEW_BUILD_ID,
                                languageVersion: input.languageVersion,
                              },
                            }
                          : null
                      )
                    }}
                    onActiveEditConflict={() => callbacks.current?.conflict()}
                    onActiveEditHandleChange={captureHandle}
                    renderBlocksTransform={(blocks) =>
                      applyFreshImageUrls(blocks, mediaUrls) as Block[]
                    }
                    renderPage={(blocks, context) =>
                      BlockBody ? (
                        <BlockBody
                          // Unsaved field values replace the stored ones, so
                          // e.g. an author's name and role update live.
                          page={
                            {
                              ...page,
                              ...liveFrameFieldValues(
                                page.pageType,
                                "sharedFields",
                                input.sharedFields
                              ),
                            } as BlockBodyDoc
                          }
                          content={{
                            ...liveFrameFieldValues(
                              page.pageType,
                              "localizedFields",
                              input.localizedFields
                            ),
                            title: input.title,
                            blocks,
                          }}
                          blocks={blocks}
                          ctx={context}
                          locale={input.locale}
                          renderLocale={input.locale}
                          defaultLocale={input.defaultLocale}
                          bylines={bylines}
                        />
                      ) : null
                    }
                  />
                </PublicSiteShell>
              </div>
            </ThemeProvider>
          </PresentationLocaleProvider>
        )}
      </LiveFrameContext>
    </LiveFrameRenderBoundary>
  )
}

const AUTHOR_IDS_PUBLIC =
  "authorIds" in publicFieldsOf(postContentType.sharedFields)

function bylineQueries(
  authorIds: string[],
  locale: string,
  languageVersion: number
): RequestForQueries {
  return Object.fromEntries(
    authorIds.map((authorPageId, index) => [
      String(index),
      {
        query: api.cms.pages.getPublicByline,
        args: {
          authorPageId: authorPageId as Id<"pages">,
          locale,
          languageVersion,
        },
      },
    ])
  )
}

/** Independent reads form display context, never Save or field-write authority. */
function LiveFrameContext({
  input,
  presentationCatalog,
  onContext,
  onUnavailable,
  children,
}: {
  input: LiveFrameInput
  presentationCatalog?: BlockPresentationCatalog
  onContext(ready: boolean): void
  onUnavailable(): void
  children(
    ctx: BlockRenderContext,
    mediaUrls: Record<string, string>,
    ready: boolean,
    bylines: PublicByline[]
  ): ReactNode
}) {
  const { isLoading, isAuthenticated } = useConvexAuth()
  const authenticated = !isLoading && isAuthenticated
  const view = useQuery(
    api.cms.pages.getForEdit,
    authenticated ? { id: input.pageId as Id<"pages"> } : "skip"
  )
  const config = useQuery(
    api.cms.settings.getSiteConfig,
    authenticated ? {} : "skip"
  )
  const authorized =
    authenticated &&
    supportsLivePreviewFrame(view?.page.pageType) &&
    config?.enabledLocales.includes(input.locale) === true &&
    config.languageVersion === input.languageVersion &&
    config.defaultLocale === input.defaultLocale
  const storage = new Set<Id<"_storage">>()
  collectImageStorageIds(input.blocks, storage)
  const storageIds = [...storage].toSorted()
  const pageIds = collectPageIds(input.blocks).toSorted()
  const relationIds = collectRelationIds(input.blocks).toSorted()
  // The existing media query truncates at 100. Never admit a partial context.
  const withinMediaLimit = storageIds.length <= 100
  const canResolve = authorized && withinMediaLimit
  const media = useQuery(
    api.cms.media.getStorageUrls,
    canResolve && storageIds.length ? { storageIds } : "skip"
  )
  const paths = useQuery(
    api.cms.pages.getLocalizedPathsByIds,
    canResolve && pageIds.length
      ? {
          ids: pageIds,
          locale: input.locale,
          languageVersion: input.languageVersion,
        }
      : "skip"
  )
  const cards = useQuery(
    api.cms.pages.getRelationCardsByIds,
    canResolve && relationIds.length
      ? { ids: relationIds, locale: input.locale, includeDrafts: true }
      : "skip"
  )
  // Post bylines use the public page's rules for this language: the same
  // public query and exposure gate, so an author visitors cannot see (draft,
  // archived, or missing this language) is left out here too.
  // useQueries resubscribes whenever its argument object changes, so the
  // request is rebuilt only when the selection, language or version changes.
  const authorIds =
    canResolve && view?.page.pageType === "post" && AUTHOR_IDS_PUBLIC
      ? (input.authorIds ?? [])
      : []
  const bylineKey = JSON.stringify([
    authorIds,
    input.locale,
    input.languageVersion,
  ])
  const [bylineRequest, setBylineRequest] = useState(() => ({
    key: bylineKey,
    queries: bylineQueries(authorIds, input.locale, input.languageVersion),
  }))
  if (bylineRequest.key !== bylineKey)
    setBylineRequest({
      key: bylineKey,
      queries: bylineQueries(authorIds, input.locale, input.languageVersion),
    })
  const bylineResults = useQueries(bylineRequest.queries)
  const bylineValues = authorIds.map((_, index) =>
    bylineRequest.key === bylineKey
      ? (bylineResults[String(index)] as PublicByline | null | undefined | Error)
      : undefined
  )
  const bylineFailed = bylineValues.some((value) => value instanceof Error)
  const ready =
    canResolve &&
    (!storageIds.length || media !== undefined) &&
    (!pageIds.length || paths !== undefined) &&
    (!relationIds.length || cards !== undefined) &&
    !bylineFailed &&
    bylineValues.every((value) => value !== undefined)
  const unavailable =
    (!isLoading && !isAuthenticated) ||
    (authenticated &&
      view !== undefined &&
      config !== undefined &&
      !authorized) ||
    !withinMediaLimit ||
    bylineFailed
  useLayoutEffect(() => {
    onContext(ready)
    if (unavailable) onUnavailable()
  }, [ready, unavailable, onContext, onUnavailable])
  const ctx: BlockRenderContext = {
    locale: input.locale,
    presentationLocale: input.locale,
    defaultLocale: input.defaultLocale,
    languageVersion: input.languageVersion,
    pagePaths: ready ? (paths ?? {}) : {},
    relationCards: ready ? (cards ?? {}) : {},
    presentationCatalog,
  }
  const bylines = ready
    ? bylineValues.filter(
        (value): value is PublicByline => !!value && !(value instanceof Error)
      )
    : []
  return children(ctx, ready ? (media ?? {}) : {}, ready, bylines)
}

/** Rendering failures cannot destroy the parent draft or escape the frame. */
class LiveFrameRenderBoundary extends Component<
  { children: ReactNode; onError(): void; message: string },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    this.props.onError()
  }
  render() {
    return this.state.failed ? (
      <p role="status">{this.props.message}</p>
    ) : (
      this.props.children
    )
  }
}
