"use client"
import {
  cloneElement,
  isValidElement,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { simulatorTypographyStyles } from "./sim-typography-styles"
import type { TypographyPreviewEdits } from "@/lib/slices/visual-tweak/typography"
import { SliceZone } from "@/components/slices/slice-zone"
import { SLICE_SIM_COMPONENTS } from "@/components/slices/slice-sim-registry"
import { PublicSurface } from "@/components/ui/public-surface"
import {
  PreviewInlineEditor,
  type PreviewInlineController,
} from "@/components/admin/preview-inline-editor"
import type { Slice } from "@/convex/lib/slices"
import type { SliceRenderContext } from "@/lib/slices/links"
import {
  fieldHeadingLevel,
  type resolvePageOutline,
} from "@/lib/slices/page-outline"
import { flattenSliceContent } from "@/lib/slices/flatten-content"
import type { TweakTargetMetadata } from "./tweak-target"
import { SliceTargetLayer } from "./slice-target-layer"
import { SimSizeReporter } from "./sim-size-reporter"
import {
  canonicalSamplePath,
  canonicalSampleValue,
  projectSamples,
  sampleFields,
  validSampleValue,
  type SampleField,
  type SampleValues,
} from "./sim-sample-state"
import {
  historyIntent,
  postSimMessage,
  SIM_FRAME_SOURCE,
  type SimFrameBridge,
  type SimFrameCallbacks,
  type SimFrameInput,
  type SimFrameWindow,
} from "./sim-frame-bridge"

type Active = {
  field: SampleField
  id: string
  point?: { left: number; top: number }
  value: string
}
/** Same-document editor island; only the parent reducer owns accepted samples. */
export function SimSampleFrame({
  seed,
  context,
  outline,
  targets,
}: {
  seed: Slice
  context: SliceRenderContext
  outline: ReturnType<typeof resolvePageOutline>
  targets: TweakTargetMetadata[]
}) {
  const fields = sampleFields(seed)
  const fieldsKey = JSON.stringify(fields)
  const [typography, setTypography] = useState<TypographyPreviewEdits>({})
  const [values, setValues] = useState<SampleValues>({})
  const valuesRef = useRef(values)
  const projectedValues = useRef(values)
  const [projectionRevision, setProjectionRevision] = useState(0)
  function publishValues(next: SampleValues) {
    projectedValues.current = next
    setValues(next)
  }
  const [active, setActive] = useState<Active | null>(null)
  const activeRef = useRef(active)
  const [mode, setMode] = useState<"edit" | "preview">("edit")
  const modeRef = useRef(mode)
  const controller = useRef<PreviewInlineController | null>(null)
  const bridgeRef = useRef<SimFrameBridge | null>(null)
  const callbacks = useRef<SimFrameCallbacks | null>(null)
  const editRevision = useRef(0)
  const replayRevision = useRef(-1)
  const resetRevision = useRef(-1)
  function change(value: string) {
    const current = activeRef.current,
      bridge = bridgeRef.current
    if (!current || !bridge || !validSampleValue(current.field, value)) return
    const selection = {
      path: current.field.path,
      from: selected.current.from,
      to: selected.current.to,
    }
    const accepted = callbacks.current?.change({
      generation: bridge.generation,
      sessionId: bridge.sessionId,
      editorSessionId: current.id,
      revision: ++editRevision.current,
      path: current.field.path,
      value,
      selection,
    })
    if (!accepted) return
    valuesRef.current = { ...valuesRef.current, [current.field.path]: value }
    publishValues(valuesRef.current)
  }
  const selected = useRef({ from: 1, to: 1 })
  function commit(write = true, alreadyFlushed = false) {
    if (write && !alreadyFlushed) controller.current?.flush()
    // Changed Reset finishes without publishing the old native document. Old
    // callbacks are invalid before selection/group completion can re-enter us.
    activeRef.current = null
    controller.current = null
    if (!alreadyFlushed) callbacks.current?.groupEnd()
    callbacks.current?.selection?.(null)
    setActive(null)
    if (write) publishValues(valuesRef.current)
  }
  const finishSession = useEffectEvent(
    (write?: boolean, alreadyFlushed?: boolean) => commit(write, alreadyFlushed)
  )
  useEffect(() => {
    const fields: SampleField[] = JSON.parse(fieldsKey)
    function valuesKey(next: SampleValues) {
      return JSON.stringify(
        fields.map((field) => {
          const value = next[field.path] ?? field.value
          return canonicalSampleValue(field, value) ?? value
        })
      )
    }
    const generation = crypto.randomUUID()
    let live = true
    const bridge: SimFrameBridge = {
      generation,
      sessionId: "",
      acceptedParentRevision: 0,
      lastReplaceRevision: 0,
      appliedRevision: 0,
      current: () =>
        live && (window as SimFrameWindow).__formulacmsSimFrame === bridge,
      incomingRevision: 0,
      outgoingRevision: 0,
      fields,
      targets: targets.map((target) => ({
        ...target,
        label: target.tag,
        path: target.loc,
      })),
      editorSessionId: () => activeRef.current?.id ?? null,
      controller: () => controller.current,
      connect(sessionId, next) {
        bridge.sessionId = sessionId
        callbacks.current = next
      },
      replace(input: SimFrameInput) {
        if (
          !bridge.current() ||
          input.generation !== generation ||
          input.sessionId !== bridge.sessionId ||
          !Number.isSafeInteger(input.revision) ||
          !Number.isSafeInteger(input.reset) ||
          input.revision <= bridge.acceptedParentRevision
        )
          return false
        if (
          Object.keys(input.values).length > 10 ||
          Object.entries(input.values).some(
            ([path, value]) =>
              !fields.some(
                (field) => field.path === path && validSampleValue(field, value)
              )
          )
        )
          return false
        bridge.acceptedParentRevision = input.revision
        bridge.lastReplaceRevision = input.revision
        const changedReset =
          input.reset !== resetRevision.current &&
          !!activeRef.current &&
          (valuesKey(input.values) !== valuesKey(valuesRef.current) ||
            valuesKey(input.values) !== valuesKey(projectedValues.current))
        resetRevision.current = input.reset
        let nextValues = input.values
        if (changedReset) {
          finishSession(false)
        } else if (input.mode === "preview" && activeRef.current) {
          const path = activeRef.current.field.path
          const beforeFlush = valuesRef.current
          finishSession()
          // A flush is accepted synchronously, after this incoming snapshot was
          // made. Keep that newer field while retaining the other parent values.
          if (valuesRef.current !== beforeFlush)
            nextValues = { ...input.values, [path]: valuesRef.current[path] }
        }
        valuesRef.current = nextValues
        publishValues(nextValues)
        setProjectionRevision(input.revision)
        modeRef.current = input.mode
        setMode(input.mode)
        setTypography(input.typography ?? {})
        document.documentElement.dataset.simMode = input.mode
        if (input.replay !== replayRevision.current) {
          replayRevision.current = input.replay
          const session = activeRef.current
          const value =
            session && (input.values[session.field.path] ?? session.field.value)
          if (session && typeof value === "string") {
            controller.current?.replay(
              value,
              input.selection?.path === session.field.path
                ? input.selection
                : undefined
            )
          }
        }
        return true
      },
      flush() {
        if (!bridge.current()) return false
        const value = controller.current?.flush()
        if (value?.composing) return false
        callbacks.current?.groupEnd()
        return true
      },
      format(command) {
        return controller.current?.format(command, selected.current) ?? false
      },
    }
    bridgeRef.current = bridge
    const frameWindow = window as SimFrameWindow
    frameWindow.__formulacmsSimFrame = bridge
    const retire = (event?: PageTransitionEvent) => {
      if (event?.persisted) return
      live = false
      if (frameWindow.__formulacmsSimFrame === bridge)
        delete frameWindow.__formulacmsSimFrame
    }
    const announce = () =>
      postSimMessage({
        type: "layer-ready",
        width: window.innerWidth,
        height: Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight
        ),
      })
    const hello = (event: MessageEvent) => {
      if (
        event.origin === window.location.origin &&
        event.source === window.parent &&
        event.data?.source === SIM_FRAME_SOURCE &&
        event.data.type === "hello"
      )
        announce()
    }
    const history = (event: KeyboardEvent | InputEvent) => {
      const intent = historyIntent(event)
      if (!intent || modeRef.current !== "edit" || !bridge.flush()) return
      event.preventDefault()
      event.stopImmediatePropagation()
      callbacks.current?.history(intent)
    }
    const save = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        if (!event.repeat) callbacks.current?.save()
      }
    }
    window.addEventListener("pagehide", retire)
    window.addEventListener("message", hello)
    document.addEventListener("keydown", history, true)
    document.addEventListener("beforeinput", history, true)
    document.addEventListener("keydown", save, true)
    announce()
    return () => {
      window.removeEventListener("pagehide", retire)
      retire()
      window.removeEventListener("message", hello)
      document.removeEventListener("keydown", history, true)
      document.removeEventListener("beforeinput", history, true)
      document.removeEventListener("keydown", save, true)
      if (frameWindow.__formulacmsSimFrame === bridge)
        delete frameWindow.__formulacmsSimFrame
      bridgeRef.current = null
      callbacks.current = null
    }
  }, [fieldsKey, targets])

  // Acknowledge replacement only after React has committed its projected DOM.
  useLayoutEffect(() => {
    const bridge = bridgeRef.current
    if (!bridge || projectionRevision !== bridge.lastReplaceRevision) return
    bridge.appliedRevision = projectionRevision
    postSimMessage({
      type: "samples-applied",
      appliedRevision: projectionRevision,
    })
  }, [projectionRevision])

  const projected = projectSamples(seed, values)
  const entries = flattenSliceContent(projected)
  // The active native field keeps its existing render seed until it finishes.
  const renderedSlice = projectSamples(
    projected,
    active ? { [active.field.path]: active.value } : {}
  )
  function intercept(path: string, rendered: ReactNode) {
    const field = fields.find(
      (field) => field.path === canonicalSamplePath(path)
    )
    if (!field || !isValidElement<Record<string, unknown>>(rendered))
      return rendered
    if (active?.field.path === field.path) {
      const block =
        field.contract !== "plain" &&
        field.contract !== "inline" &&
        field.contract !== "title"
      return cloneElement(
        rendered,
        { "data-sim-field": field.path },
        <PreviewInlineEditor
          key={active.id}
          value={active.value}
          contract={field.contract === "plain" ? "inline" : field.contract}
          fieldPath={field.path}
          label={field.path}
          initialPoint={active.point}
          className={
            block
              ? "prose max-w-none prose-neutral dark:prose-invert"
              : undefined
          }
          simulator={{
            block,
            plain: field.contract === "plain",
            headingFloor: fieldHeadingLevel(
              outline.fieldsBySliceId[seed.id],
              path
            ),
            onController(next) {
              const current = activeRef.current
              if (current?.id !== active.id) return
              controller.current = next
              if (next)
                callbacks.current?.selection?.({
                  path: current.field.path,
                  editorSessionId: current.id,
                  ...selected.current,
                  text: next.textState(),
                })
            },
            onSelection(next, text) {
              const current = activeRef.current
              if (current?.id !== active.id) return
              selected.current = next
              if (current)
                callbacks.current?.selection?.({
                  path: current.field.path,
                  editorSessionId: current.id,
                  ...next,
                  text,
                })
            },
            onGroupEnd() {
              if (activeRef.current?.id === active.id)
                callbacks.current?.groupEnd()
            },
          }}
          onChange={(value) => {
            if (activeRef.current?.id === active.id) change(value)
          }}
          onCancel={() => {
            if (activeRef.current?.id === active.id) commit()
          }}
          onCommit={() => {
            if (activeRef.current?.id === active.id) commit()
          }}
          onCompositionChange={(composing) => {
            if (!composing && activeRef.current?.id === active.id)
              callbacks.current?.groupEnd()
          }}
        />
      )
    }
    const publicClick = rendered.props.onClick
    return cloneElement(rendered, {
      "data-sim-field": field.path,
      onClick(event: React.MouseEvent) {
        if (
          mode !== "edit" ||
          (event.target instanceof Element &&
            event.target.closest("[data-preview-inline-editor]"))
        ) {
          if (typeof publicClick === "function") publicClick(event)
          return
        }
        if (!bridgeRef.current?.flush()) return
        if (activeRef.current) commit(true, true)
        event.preventDefault()
        event.stopPropagation()
        const value = valuesRef.current[field.path] ?? field.value
        const session = {
          field,
          value,
          id: crypto.randomUUID(),
          point:
            event.clientX || event.clientY
              ? { left: event.clientX, top: event.clientY }
              : undefined,
        }
        selected.current = { from: 1, to: 1 }
        controller.current = null
        activeRef.current = session
        editRevision.current = 0
        setActive(session)
      },
    })
  }
  const ctx: SliceRenderContext = {
    ...context,
    previewRichText: ({ fieldPath, rendered }) =>
      intercept(fieldPath, rendered),
    previewField: ({ fieldPath, rendered }) => intercept(fieldPath, rendered),
  }
  return (
    <>
      <style data-sim-typography="">{simulatorTypographyStyles(typography)}</style>
      <PublicSurface data-public-simulator="" data-slice-preview-root="">
        <SliceZone
          slices={[renderedSlice]}
          ctx={ctx}
          outline={outline}
          registry={SLICE_SIM_COMPONENTS}
        />
      </PublicSurface>
      <SliceTargetLayer entries={entries} targets={targets} typographyRevision={JSON.stringify(typography)} />
      <SimSizeReporter />
    </>
  )
}
