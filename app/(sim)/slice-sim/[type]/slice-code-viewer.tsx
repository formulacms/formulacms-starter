"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import type {
  CodeTarget,
  SliceCodeSnapshot,
} from "@/lib/slices/visual-tweak/read-code"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { readSliceCodeAction } from "./read-code"
import { SLICE_LAYER_READY_EVENT, type TargetInfo } from "./slice-preview"
import { useVisualTweak } from "./visual-tweak-store"

function targetIdentity(target: CodeTarget | null) {
  return target
    ? JSON.stringify([target.loc, target.tag, target.sourceHash])
    : ""
}

/** A source snapshot and utility proposals, never editable or canonical HTML. */
export function SliceCodeViewer({
  type,
  target,
}: {
  type: string
  target: TargetInfo | null
}) {
  const { pendingRows } = useVisualTweak()
  const [snapshot, setSnapshot] = useState<SliceCodeSnapshot | null>(null)
  const [file, setFile] = useState<"renderer" | "css">("renderer")
  const [state, setState] = useState<"loading" | "ready" | "stale" | "error">(
    "loading"
  )
  const [error, setError] = useState("")
  const [navigation, setNavigation] = useState<{
    selection: string
    target: CodeTarget
  } | null>(null)
  const request = useRef(0)
  const cancelRequests = useCallback(() => {
    request.current++
  }, [])
  const selectedLine = useRef<HTMLSpanElement | null>(null)
  const latestTarget = useRef(target)
  useLayoutEffect(() => {
    latestTarget.current = target
  }, [target])
  useEffect(() => {
    let live = true
    const sequence = ++request.current
    const initialTarget = latestTarget.current
    const identity = targetIdentity(initialTarget)
    readSliceCodeAction({ type, target: initialTarget })
      .then((result) => {
        if (!live || sequence !== request.current) return
        if (identity !== targetIdentity(latestTarget.current)) {
          setState("stale")
          return
        }
        if (result.ok) {
          setSnapshot(result.snapshot)
          setState("ready")
        } else {
          setError(result.error)
          setState("error")
        }
      })
      .catch(() => {
        if (live && sequence === request.current) {
          setError("Source inspection failed. Try again.")
          setState("error")
        }
      })
    return () => {
      live = false
      cancelRequests()
    }
  }, [type, cancelRequests])
  useEffect(() => {
    const invalidate = () => {
      request.current++
      setState("stale")
    }
    window.addEventListener(SLICE_LAYER_READY_EVENT, invalidate)
    return () => window.removeEventListener(SLICE_LAYER_READY_EVENT, invalidate)
  }, [])

  const focusedTarget =
    navigation?.selection === targetIdentity(target)
      ? navigation.target
      : target
  const selected =
    snapshot &&
    focusedTarget &&
    focusedTarget.sourceHash === snapshot.renderer.digest
      ? snapshot.locations.find(
          (location) =>
            location.loc === focusedTarget.loc &&
            location.tag === focusedTarget.tag
        )
      : undefined
  const targetStale = Boolean(snapshot && target && !selected)
  const current = state === "ready" && !targetStale
  useEffect(() => {
    if (current && file === "renderer")
      selectedLine.current?.scrollIntoView({ block: "nearest" })
  }, [current, file, selected?.loc])

  async function inspectAgain() {
    const sequence = ++request.current
    const requestedTarget = latestTarget.current
    const identity = targetIdentity(requestedTarget)
    setState("loading")
    try {
      const result = await readSliceCodeAction({
        type,
        target: requestedTarget,
      })
      if (sequence !== request.current) return
      if (identity !== targetIdentity(latestTarget.current)) {
        setState("stale")
        return
      }
      if (result.ok) {
        setSnapshot(result.snapshot)
        setState("ready")
        setError("")
      } else {
        setError(result.error)
        setState("error")
      }
    } catch {
      if (sequence === request.current) {
        setError("Source inspection failed. Try again.")
        setState("error")
      }
    }
  }
  function reveal(target: CodeTarget) {
    if (
      !current ||
      !snapshot ||
      target.sourceHash !== snapshot.renderer.digest ||
      !snapshot.locations.some(
        (location) => location.loc === target.loc && location.tag === target.tag
      )
    )
      return
    setFile("renderer")
    setNavigation({ selection: targetIdentity(latestTarget.current), target })
    selectedLine.current?.scrollIntoView({ block: "nearest" })
  }

  const source = snapshot?.[file]
  return (
    <section aria-label="Read-only Block code" className="space-y-3">
      <p className="text-xs text-muted-foreground">
        React/CSS snapshot from the last inspection. Pending changes below are
        utility proposals, not a saved file patch. Imported package CSS and
        generated utilities are not expanded. Inspect again after stylesheet
        changes; this view does not watch files.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={inspectAgain}
        disabled={state === "loading"}
      >
        Inspect selected source again
      </Button>
      {state === "loading" && <p role="status">Reading registered source…</p>}
      {(state === "stale" || targetStale) && (
        <p role="alert">
          Source or selection changed. Navigation is refused until you inspect a
          current target again.
        </p>
      )}
      {state === "error" && <p role="alert">{error}</p>}
      {snapshot && (
        <>
          <div className="flex flex-wrap gap-1" aria-label="Source files">
            {(["renderer", "css"] as const).map((name) => (
              <button
                type="button"
                key={name}
                aria-pressed={file === name}
                onClick={() => setFile(name)}
                className="rounded border px-2 py-1 text-xs"
              >
                {name === "renderer" ? "React" : "CSS"}
              </button>
            ))}
          </div>
          <p className="font-mono text-xs break-all">
            {source?.path}
            <br />
            <span className="text-muted-foreground">
              SHA-256 {source?.digest}
            </span>
          </p>
          {selected && focusedTarget && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!current}
              onClick={() => reveal(focusedTarget)}
            >
              Go to selected source · line {selected.line}
            </Button>
          )}
          <pre
            aria-label={
              file === "renderer" ? "Saved renderer source" : "Saved CSS source"
            }
            className="max-h-96 overflow-auto rounded border bg-muted/30 p-2 text-xs"
          >
            <code>
              {source?.source.split("\n").map((line, index) => (
                <span
                  key={index}
                  ref={
                    file === "renderer" &&
                    current &&
                    selected?.line === index + 1
                      ? selectedLine
                      : undefined
                  }
                  data-source-line={index + 1}
                  className={cn(
                    "block",
                    file === "renderer" &&
                      current &&
                      selected?.line === index + 1 &&
                      "bg-primary/15"
                  )}
                >
                  <span
                    className="mr-3 text-muted-foreground"
                    aria-hidden="true"
                  >
                    {index + 1}
                  </span>
                  {line || " "}
                </span>
              ))}
            </code>
          </pre>
        </>
      )}
      <div>
        <h3 className="text-sm font-medium">Pending utility changes</h3>
        {pendingRows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No pending source changes.
          </p>
        ) : (
          <ul className="space-y-2">
            {pendingRows.map((row) => {
              const compatible =
                current &&
                snapshot?.renderer.digest === row.sourceHash &&
                snapshot.locations.some(
                  (location) =>
                    location.loc === row.loc && location.tag === row.tag
                )
              return (
                <li key={row.id} className="rounded border p-2 text-xs">
                  <p>
                    {row.label} · {row.scope} · {row.group}
                    {row.templateWide ? " · all repeated instances" : ""}
                  </p>
                  <pre className="overflow-auto">
                    <code>{`- ${row.before || "(no class)"}\n+ ${row.after}`}</code>
                  </pre>
                  {!compatible ? (
                    <p>
                      Proposal baseline is unqualified for this source. Save
                      retains its existing validation.
                    </p>
                  ) : (
                    <button
                      type="button"
                      onClick={() => reveal(row)}
                      className="underline"
                    >
                      Go to proposal source
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
