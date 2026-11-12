"use client"
import { useEffect } from "react"
import { Eye, Info, Pencil, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useVisualTweak } from "./visual-tweak-store"
import { SAMPLE_PRESETS } from "./sim-sample-presets"
import { SIM_ACCENT } from "./sim-accent"

export function SimModeControl() {
  const { mode, setMode } = useVisualTweak()
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing ||
        (event.target instanceof Element &&
          event.target.closest('input,textarea,[contenteditable="true"]'))
      )
        return
      if (event.key.toLowerCase() === "i") setMode("preview")
      if (event.key.toLowerCase() === "d") setMode("edit")
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [setMode])
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={mode}
      aria-label="Simulator mode"
      onValueChange={(value) => {
        if (value === "edit" || value === "preview") setMode(value)
      }}
    >
      <ToggleGroupItem
        value="preview"
        aria-label="Preview"
        title="Preview (I)"
        className={SIM_ACCENT.pressedTool}
      >
        <Eye />
        Preview
      </ToggleGroupItem>
      <ToggleGroupItem
        value="edit"
        aria-label="Edit"
        title="Edit (D)"
        className={SIM_ACCENT.pressedTool}
      >
        <Pencil />
        Edit
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
export function SimSampleControls() {
  const { preset, setPreset, resetSamples } = useVisualTweak()
  const info =
    "Sample text is remembered in this browser for this block, presentation and locale. Page content and shared samples are unchanged."
  return (
    <div
      role="group"
      className="flex items-center gap-1 rounded-lg border bg-background p-1 shadow-sm"
      aria-label="Sample content controls"
    >
      <ToggleGroup
        type="single"
        size="sm"
        value={preset}
        aria-label="Sample preset"
        onValueChange={(value) => {
          if (value) setPreset(value)
        }}
      >
        {SAMPLE_PRESETS.map((item) => (
          <ToggleGroupItem
            key={item.key}
            value={item.key}
            className={SIM_ACCENT.pressedTool}
          >
            {item.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Reset sample text"
        title="Reset sample text"
        onClick={resetSamples}
      >
        <RotateCcw />
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={info}>
            <Info />
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{info}</TooltipContent>
      </Tooltip>
    </div>
  )
}
