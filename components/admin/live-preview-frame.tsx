"use client"

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { PREVIEW_BUILD_ID } from "@/lib/preview-build-id"
import { useTheme } from "next-themes"
import { useTranslations } from "next-intl"
import {
  ExternalLink,
  Monitor,
  PencilLine,
  Smartphone,
  Tablet,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import type { Slice } from "@/convex/lib/slices"
import type {
  PreviewActiveEditHandle,
  PreviewFieldSelection,
  PreviewInlineActivationResult,
  PreviewInlineEditCommit,
} from "./visual-editing-types"
import {
  createLiveFrameController,
  liveFrameMessageMatches,
  sameLiveFrameIdentity,
  LIVE_FRAME_SOURCE,
  type LiveFrameBridge,
  type LiveFrameInput,
  type LiveFrameWindow,
} from "./live-preview-frame-bridge"
import {
  supportsLivePreviewFrame,
  type LivePreviewPageType,
} from "./live-preview-page-type"

export type PageLivePreviewProps = {
  title: string
  slices: Slice[]
  locale: string
  defaultLocale: string
  pageId?: string
  pageType?: string
  languageVersion?: number
  contentEpoch?: number
  draftRevision?: number
  getDraftRevision?(): number
  catalogRevision?: string
  inlineEditingBlocked?: boolean
  selectedSliceId: string | null
  onSelectSlice(id: string): void
  onSelectSliceFallback?(id: string): void
  onSelectField(
    target: PreviewFieldSelection,
    result?: PreviewInlineActivationResult
  ): void
  onInlineEditCommit(commit: PreviewInlineEditCommit): boolean | void
  onInlineEditingEnabledChange?(enabled: boolean): void
  onActiveEditHandleChange?(handle: PreviewActiveEditHandle | null): void
  onActiveEditChange?(commit: PreviewInlineEditCommit | null): void
  onActiveEditConflict?(): void
  onSave(): void
  onOpenSavedPreview(): void
}
const VIEWPORTS = {
  desktop: { width: 1280, height: 900, Icon: Monitor },
  tablet: { width: 768, height: 1024, Icon: Tablet },
  mobile: { width: 390, height: 844, Icon: Smartphone },
}

export function LivePreviewFrame(props: PageLivePreviewProps) {
  const t = useTranslations("editor.livePreview")
  if (
    !props.pageId ||
    !supportsLivePreviewFrame(props.pageType) ||
    !Number.isSafeInteger(props.languageVersion)
  )
    return (
      <div className="space-y-3 p-4">
        <p role="status">{t("frameUnsupported")}</p>
        <button type="button" onClick={props.onOpenSavedPreview}>
          {t("saved")}
        </button>
      </div>
    )
  return (
    <BoundLivePreviewFrame
      key={`${props.pageId}:${props.locale}:${props.languageVersion}`}
      {...props}
      pageId={props.pageId}
      pageType={props.pageType}
      languageVersion={props.languageVersion!}
    />
  )
}

// Module-level so the try/catch (with optional chaining) stays out of the
// component body: React Compiler 1.0.0 skips components containing it.
function isCurrentFrameBridge(
  element: HTMLIFrameElement | null,
  bridge: LiveFrameBridge
): boolean {
  try {
    const contentWindow = element?.contentWindow as LiveFrameWindow | null
    return contentWindow?.__formulacmsLiveFrame === bridge
  } catch {
    return false
  }
}

// True when `next` carries the same values as the input last pushed. Every
// field is compared by identity (slices by array identity, never by JSON).
// `ordering` is compared by its parent-owned part: draftRevision. inputRevision
// and generation are stamped by the push itself.
function sameLivePushInput(
  previous: LiveFrameInput | null,
  next: LiveFrameInput
): boolean {
  if (!previous) return false
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)])
  for (const key of keys) {
    if (key === "ordering") {
      if (previous.ordering?.draftRevision !== next.ordering?.draftRevision)
        return false
      if (!previous.ordering !== !next.ordering) return false
    } else if (
      !Object.is(
        (previous as Record<string, unknown>)[key],
        (next as Record<string, unknown>)[key]
      )
    )
      return false
  }
  return true
}

function BoundLivePreviewFrame(
  props: PageLivePreviewProps & {
    pageId: string
    pageType: LivePreviewPageType
    languageVersion: number
  }
) {
  const t = useTranslations("editor.livePreview")
  const { resolvedTheme } = useTheme()
  const [sessionId] = useState(() => crypto.randomUUID())
  const [viewport, setViewport] = useState<keyof typeof VIEWPORTS>("desktop")
  const [zoom, setZoom] = useState("fit")
  const [inlineEditingEnabled, setInlineEditingEnabled] = useState(false)
  const [width, setWidth] = useState(0)
  const [status, setStatus] = useState<
    "loading" | "ready" | "unavailable" | "conflict" | "updated"
  >("loading")
  const [slowLoading, setSlowLoading] = useState(false)
  const [loadingAttempt, setLoadingAttempt] = useState(0)
  const frame = useRef<HTMLIFrameElement | null>(null)
  const measure = useRef<HTMLDivElement | null>(null)
  const callbacks = useRef(props)
  const inputRevision = useRef(0)
  const lastPushed = useRef<LiveFrameInput | null>(null)
  const contextReady = useRef(false)
  const input: LiveFrameInput = {
    sessionId,
    buildId: PREVIEW_BUILD_ID,
    catalogRevision: props.catalogRevision ?? "",
    pageId: props.pageId,
    locale: props.locale,
    defaultLocale: props.defaultLocale,
    languageVersion: props.languageVersion,
    pageType: props.pageType,
    title: props.title,
    slices: props.slices,
    contentEpoch: props.contentEpoch ?? 0,
    selectedSliceId: props.selectedSliceId,
    inlineEditingEnabled:
      inlineEditingEnabled &&
      !props.inlineEditingBlocked &&
      status !== "updated",
    mode: resolvedTheme === "dark" ? "dark" : "light",
    ...(props.draftRevision !== undefined && props.getDraftRevision
      ? {
          ordering: {
            draftRevision: props.draftRevision,
            inputRevision: 0,
            generation: "",
          },
        }
      : {}),
  }
  const [controller] = useState(() => createLiveFrameController(input))
  useLayoutEffect(() => {
    controller.setCurrentBridgeCheck((bridge: LiveFrameBridge) =>
      isCurrentFrameBridge(frame.current, bridge)
    )
    callbacks.current = props
    controller.replaceCallbacks({
      selectSlice: props.onSelectSlice,
      selectSliceFallback: props.onSelectSliceFallback,
      selectField: props.onSelectField,
      commit: props.onInlineEditCommit,
      draftRevision: props.getDraftRevision,
      change: (commit) => props.onActiveEditChange?.(commit),
      conflict: () => {
        setStatus("conflict")
        props.onActiveEditConflict?.()
      },
      unavailable: () => setStatus("unavailable"),
      context: (ready) => {
        contextReady.current = ready
        if (ready) setSlowLoading(false)
        setStatus(ready ? "ready" : "loading")
      },
      save: props.onSave,
    })
    // Push the input only when a field of it changed (compared by identity),
    // not on every parent render. inputRevision still rises on every push.
    if (!sameLivePushInput(lastPushed.current, input)) {
      lastPushed.current = input
      controller.replaceInput({
        ...input,
        ...(input.ordering
          ? {
              ordering: {
                ...input.ordering,
                inputRevision: ++inputRevision.current,
              },
            }
          : {}),
      })
    }
    if (!controller.generation() && !controller.handle.hasActiveSession()) {
      frame.current?.contentWindow?.postMessage(
        {
          source: LIVE_FRAME_SOURCE,
          type: "hello",
          buildId: PREVIEW_BUILD_ID,
          sessionId,
          pageId: props.pageId,
          locale: props.locale,
        },
        window.location.origin
      )
    }
  })
  useEffect(() => {
    // Discarding a conflicted buffer returns a still-connected frame to view.
    callbacks.current.onActiveEditHandleChange?.({
      ...controller.handle,
      discardActiveEdit: () => {
        controller.handle.discardActiveEdit?.()
        if (controller.generation())
          setStatus((now) =>
            now === "conflict"
              ? contextReady.current
                ? "ready"
                : "loading"
              : now
          )
      },
    })
    return () => {
      controller.retire()
      callbacks.current.onActiveEditHandleChange?.(null)
    }
  }, [controller])
  const effectiveInlineEnabled =
    inlineEditingEnabled && !props.inlineEditingBlocked
  useEffect(() => {
    callbacks.current.onInlineEditingEnabledChange?.(effectiveInlineEnabled)
  }, [effectiveInlineEnabled])

  useLayoutEffect(() => {
    const observer = new ResizeObserver(() =>
      setWidth(measure.current?.clientWidth ?? 0)
    )
    if (measure.current) observer.observe(measure.current)
    setWidth(measure.current?.clientWidth ?? 0)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const contentWindow = frame.current
        ?.contentWindow as LiveFrameWindow | null
      if (
        !liveFrameMessageMatches(event, window.location.origin, contentWindow, {
          sessionId,
          pageId: props.pageId,
          locale: props.locale,
        })
      )
        return
      if (event.data.type === "retired") {
        if (controller.generation() === event.data.generation) {
          controller.retire()
          setStatus("conflict")
        }
        return
      }
      if (event.data.type === "unloading") {
        if (
          controller.generation() === event.data.generation &&
          event.data.buildId === PREVIEW_BUILD_ID
        ) {
          controller.forget()
          setSlowLoading(false)
          setLoadingAttempt((attempt) => attempt + 1)
          setStatus("loading")
        }
        return
      }
      // A WindowProxy survives reloads. Only the bridge currently installed
      // by that document can qualify a ready notice before it affects continuity.
      const bridge = contentWindow?.__formulacmsLiveFrame
      if (
        !bridge ||
        !sameLiveFrameIdentity(bridge, event.data) ||
        bridge.generation !== event.data.generation ||
        bridge.buildId !== event.data.buildId
      )
        return
      if (bridge.buildId !== PREVIEW_BUILD_ID) {
        controller.retire()
        setStatus("updated")
        return
      }
      if (controller.generation() === bridge.generation) return
      if (controller.connect(bridge)) setStatus("loading")
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [controller, sessionId, props.pageId, props.locale])
  useEffect(() => {
    if (status !== "loading") return
    const timeout = window.setTimeout(() => {
      setSlowLoading(true)
    }, 15_000)
    return () => window.clearTimeout(timeout)
  }, [status, loadingAttempt])
  const config = VIEWPORTS[viewport]
  const scale =
    zoom === "100"
      ? 1
      : zoom === "75"
        ? 0.75
        : Math.min(1, (width || config.width) / config.width)
  const src = `/admin/pages/${encodeURIComponent(props.pageId)}/live-frame/${encodeURIComponent(props.locale)}?session=${encodeURIComponent(sessionId)}`
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {(Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[]).map((key) => {
          const { Icon } = VIEWPORTS[key]
          return (
            <button
              type="button"
              key={key}
              aria-label={t(`viewports.${key}`)}
              aria-pressed={viewport === key}
              onClick={() => setViewport(key as keyof typeof VIEWPORTS)}
            >
              <Icon className="size-4" />
            </button>
          )
        })}
        <select
          aria-label={t("zoom.label")}
          value={zoom}
          onChange={(event) => setZoom(event.target.value)}
        >
          <option value="fit">{t("zoom.fit")}</option>
          <option value="75">75%</option>
          <option value="100">100%</option>
        </select>
        <Button
          type="button"
          size="sm"
          variant={effectiveInlineEnabled ? "default" : "outline"}
          data-preview-save-control
          disabled={props.inlineEditingBlocked || status === "updated"}
          title={
            props.inlineEditingBlocked
              ? t("frameResolveRecovery")
              : t(
                  effectiveInlineEnabled
                    ? "inlineEditingOn"
                    : "inlineEditingOff"
                )
          }
          aria-label={t(
            effectiveInlineEnabled ? "inlineEditingOn" : "inlineEditingOff"
          )}
          aria-pressed={effectiveInlineEnabled}
          onClick={() => setInlineEditingEnabled((enabled) => !enabled)}
        >
          <PencilLine className="size-4" />
          {t(effectiveInlineEnabled ? "inlineEditingOn" : "inlineEditingOff")}
        </Button>
        <button type="button" onClick={props.onOpenSavedPreview}>
          <ExternalLink className="mr-1 inline size-4" />
          {t("saved")}
        </button>
      </div>
      {status !== "ready" && (
        <p role="status">
          {t(
            status === "loading"
              ? slowLoading
                ? "frameStillLoading"
                : "frameLoading"
              : status === "conflict"
                ? "frameConflict"
                : status === "updated"
                  ? "frameUpdated"
                  : "frameUnavailable"
          )}
        </p>
      )}
      {((status === "loading" && slowLoading) || status === "unavailable") && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setSlowLoading(false)
            setLoadingAttempt((attempt) => attempt + 1)
            // Use the existing iframe load lifecycle to capture/retire its bridge.
            // Waiting alone never disconnects a slow child or drops pending text.
            if (frame.current) frame.current.src = src
          }}
        >
          {t("frameRetry")}
        </Button>
      )}
      <div
        ref={measure}
        className="overflow-auto rounded-lg border bg-muted/30"
      >
        <div
          style={{ width: config.width * scale, height: config.height * scale }}
        >
          <iframe
            ref={frame}
            title={props.title}
            src={src}
            width={config.width}
            height={config.height}
            className="border-0 bg-background"
            style={{
              width: config.width,
              height: config.height,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
              visibility: status === "ready" ? "visible" : "hidden",
            }}
            onLoad={() => {
              if (controller.generation()) controller.retire()
              setSlowLoading(false)
              setLoadingAttempt((attempt) => attempt + 1)
              setStatus("loading")
              frame.current?.contentWindow?.postMessage(
                {
                  source: LIVE_FRAME_SOURCE,
                  type: "hello",
                  buildId: PREVIEW_BUILD_ID,
                  sessionId,
                  pageId: props.pageId,
                  locale: props.locale,
                },
                window.location.origin
              )
            }}
          />
        </div>
      </div>
    </div>
  )
}
