"use client"

import {
  Component,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useConvexAuth, useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import { PREVIEW_BUILD_ID } from "@/lib/preview-build-id"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import type { Slice } from "@/convex/lib/slices"
import type { SlicePresentationCatalog } from "@/convex/lib/slices/presentationResolution"
import { collectRelationIds } from "@/convex/lib/slices/resolve"
import { getContentTypeRenderer } from "@/components/content-types"
import {
  PublicSiteShell,
  type PublicSiteShellProps,
} from "@/components/public/public-site-shell"
import { PresentationLocaleProvider } from "@/components/public/presentation-locale"
import { Providers } from "@/components/providers"
import { ThemeProvider } from "@/components/theme-provider"
import { collectPageIds, type SliceRenderContext } from "@/lib/slices/links"
import {
  applyFreshImageUrls,
  collectImageStorageIds,
} from "@/lib/slices/media-urls"
import { useTranslations } from "next-intl"
import { PageLivePreviewCanvas } from "./page-live-preview-canvas"
import {
  LIVE_FRAME_SOURCE,
  sameLiveFrameIdentity,
  validLiveFrameInput,
  type LiveFrameBridge,
  type LiveFrameCallbacks,
  type LiveFrameIdentity,
  type LiveFrameInput,
  type LiveFrameWindow,
} from "./live-preview-frame-bridge"
import {
  supportsLivePreviewFrame,
  type LivePreviewPageType,
} from "./live-preview-page-type"
import type { PreviewActiveEditHandle } from "./visual-editing-types"

type FrameProps = {
  identity: LiveFrameIdentity
  page: Extract<Doc<"pages">, { pageType: LivePreviewPageType }>
  config: {
    defaultLocale: string
    enabledLocales: string[]
    languageVersion: number
  }
  shell: Omit<PublicSiteShellProps, "children">
  presentationCatalog?: SlicePresentationCatalog
  /** Anonymous, version-pinned bootstrap path; never an authenticated draft path. */
  publicPath?: string | null
}

/** The private frame has its own root document and authenticated provider. */
export function LivePreviewFrameRuntime(props: FrameProps) {
  return (
    <Providers>
      <ConnectedLivePreviewFrame {...props} />
    </Providers>
  )
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
  const SliceBody = renderer.kind === "sliceBody" ? renderer.Component : null
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
        {(ctx, mediaUrls, ready) => (
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
                  // Preview chrome is view-only; slice interactions are intercepted below.
                  if (
                    event.target instanceof Element &&
                    !event.target.closest("[data-preview-slice-occurrence]")
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
                    slices={input.slices}
                    contentEpoch={input.contentEpoch}
                    inlineEditEcho={input.inlineEditEcho}
                    locale={input.locale}
                    defaultLocale={input.defaultLocale}
                    selectedSliceId={input.selectedSliceId}
                    controlledInlineEnabled={input.inlineEditingEnabled}
                    renderContext={ctx}
                    onSelectSlice={(id) => callbacks.current?.selectSlice(id)}
                    onSelectSliceFallback={(id) =>
                      callbacks.current?.selectSliceFallback?.(id)
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
                    renderSlicesTransform={(slices) =>
                      applyFreshImageUrls(slices, mediaUrls) as Slice[]
                    }
                    renderPage={(slices, context) =>
                      SliceBody ? (
                        <SliceBody
                          page={page}
                          content={{ title: input.title, slices }}
                          slices={slices}
                          ctx={context}
                          locale={input.locale}
                          renderLocale={input.locale}
                          defaultLocale={input.defaultLocale}
                          bylines={[]}
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

/** Independent reads form display context, never Save or field-write authority. */
function LiveFrameContext({
  input,
  presentationCatalog,
  onContext,
  onUnavailable,
  children,
}: {
  input: LiveFrameInput
  presentationCatalog?: SlicePresentationCatalog
  onContext(ready: boolean): void
  onUnavailable(): void
  children(
    ctx: SliceRenderContext,
    mediaUrls: Record<string, string>,
    ready: boolean
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
  collectImageStorageIds(input.slices, storage)
  const storageIds = [...storage].toSorted()
  const pageIds = collectPageIds(input.slices).toSorted()
  const relationIds = collectRelationIds(input.slices).toSorted()
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
  const ready =
    canResolve &&
    (!storageIds.length || media !== undefined) &&
    (!pageIds.length || paths !== undefined) &&
    (!relationIds.length || cards !== undefined)
  const unavailable =
    (!isLoading && !isAuthenticated) ||
    (authenticated &&
      view !== undefined &&
      config !== undefined &&
      !authorized) ||
    !withinMediaLimit
  useLayoutEffect(() => {
    onContext(ready)
    if (unavailable) onUnavailable()
  }, [ready, unavailable, onContext, onUnavailable])
  const ctx: SliceRenderContext = {
    locale: input.locale,
    presentationLocale: input.locale,
    defaultLocale: input.defaultLocale,
    languageVersion: input.languageVersion,
    pagePaths: ready ? (paths ?? {}) : {},
    relationCards: ready ? (cards ?? {}) : {},
    presentationCatalog,
  }
  return children(ctx, ready ? (media ?? {}) : {}, ready)
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
