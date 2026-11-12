"use client"

import { useState } from "react"
import dynamic from "next/dynamic"
import type { ComponentProps } from "react"
import type { TargetEntry } from "@/lib/slices/flatten-content"
import { ArrowUpToLine, Code2, Repeat2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { SLICE_HIGHLIGHT_EVENT } from "./slice-preview"
import { InspectorRail } from "./inspector-rail"

const CodeViewer = dynamic(
  () => import("./slice-code-viewer").then((module) => module.SliceCodeViewer),
  {
    ssr: false,
    loading: () => (
      <p role="status" className="p-3 text-sm">
        Loading read-only Code…
      </p>
    ),
  }
)

/** One C sidebar; section changes never remount the shared pending provider. */
export function BuilderSidebar({
  type,
  showCode,
  onShowCodeChange,
  ...properties
}: ComponentProps<typeof InspectorRail> & {
  type: string
  outline: TargetEntry[]
  showCode?: boolean
  onShowCodeChange?: (show: boolean) => void
}) {
  const [section, setSection] = useState<"properties" | "code">("properties")
  const [codeOpened, setCodeOpened] = useState(false)
  const codeVisible = showCode ?? section === "code"
  if (codeVisible && !codeOpened) setCodeOpened(true)
  function toggleCode() {
    const next = !codeVisible
    setSection(next ? "code" : "properties")
    onShowCodeChange?.(next)
  }
  const headingLevel = properties.target?.headingLevel
    ? `H${properties.target.headingLevel}`
    : null
  return (
    <aside
      aria-label="Block builder sidebar"
      className="h-full min-w-0 overflow-y-auto border-l bg-background [@media(max-width:760px)]:border-t [@media(max-width:760px)]:border-l-0"
    >
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-medium">
          {codeVisible ? "Code" : (properties.target?.label ?? "Inspector")}
        </span>
        {!codeVisible && headingLevel && (
          <Badge
            variant="secondary"
            aria-label={`Heading level ${headingLevel}`}
            className="rounded px-1 text-[10px]"
          >
            {headingLevel}
          </Badge>
        )}
        {properties.target?.templateWide && (
          <span
            role="img"
            aria-label="All repeated instances"
            title="All repeated instances"
          >
            <Repeat2 className="size-3.5" />
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="border-0 shadow-none"
          aria-label="Select parent"
          title="Select parent"
          disabled={!properties.target?.parentLoc}
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent(SLICE_HIGHLIGHT_EVENT, {
                detail: { path: properties.target?.parentLoc, mode: "select" },
              })
            )
          }
        >
          <ArrowUpToLine />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="border-0 shadow-none"
          aria-label={codeVisible ? "Close Code" : "Code"}
          aria-pressed={codeVisible}
          title={codeVisible ? "Close Code" : "Code"}
          onClick={toggleCode}
        >
          {codeVisible ? <X /> : <Code2 />}
        </Button>
      </div>
      <div hidden={codeVisible}>
        <InspectorRail
          {...properties}
          onCode={toggleCode}
          showHeader={false}
          embedded
        />
      </div>
      <div hidden={!codeVisible} className="p-2">
        {codeOpened && <CodeViewer type={type} target={properties.target} />}
      </div>
    </aside>
  )
}
