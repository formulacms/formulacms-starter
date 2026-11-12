"use client"
import {
  Bold,
  Strikethrough,
  Underline,
  Highlighter,
  Subscript,
  Superscript,
  Ellipsis,
  CornerDownLeft,
  Pilcrow,
  List,
  ListOrdered,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { PreviewInlineFormat } from "@/components/admin/preview-inline-editor"
import { useVisualTweak } from "./visual-tweak-store"
import { SIM_ACCENT } from "./sim-accent"
import { SimInspectorSection } from "./sim-inspector-section"

const primary = [
  { command: "italic", label: "Emphasis", icon: null },
  { command: "bold", label: "Strong", icon: Bold },
] as const
const more = [
  { command: "strike", label: "Strikethrough", icon: Strikethrough },
  { command: "underline", label: "Underline", icon: Underline },
  { command: "highlight", label: "Highlight", icon: Highlighter },
  { command: "subscript", label: "Subscript", icon: Subscript },
  { command: "superscript", label: "Superscript", icon: Superscript },
] as const
const blocks = [
  { command: "paragraph", label: "Paragraph", icon: Pilcrow },
  { command: "bulletList", label: "Bullets", icon: List },
  { command: "orderedList", label: "Numbering", icon: ListOrdered },
  { command: "heading", label: "Heading", icon: null },
  { command: "subheading", label: "Subheading", icon: null },
] as const
export function SimTypographyBadge() {
  const { activeText, mode } = useVisualTweak()
  if (!activeText || activeText.field.contract === "plain" || mode !== "edit")
    return null
  const emptyHeading =
    activeText.block === "heading" && activeText.headingLevel === null
  const level = activeText.headingLevel
    ? `H${activeText.headingLevel}`
    : emptyHeading
      ? "—"
      : "P"
  return (
    <Badge
      variant="outline"
      aria-label={
        emptyHeading
          ? "Empty heading — omitted from output"
          : `Current text block ${level}`
      }
    >
      {level}
    </Badge>
  )
}

export function SimTextFormatting() {
  const { activeText, mode, formatSample } = useVisualTweak()
  if (!activeText || activeText.field.contract === "plain" || mode !== "edit")
    return null
  const block =
    activeText.field.contract === "basic" ||
    activeText.field.contract === "full"
  function marks(
    next: string[],
    commands: readonly { command: PreviewInlineFormat }[]
  ) {
    const changed = commands.find(
      (item) =>
        next.includes(item.command) !== activeText!.marks.includes(item.command)
    )
    if (changed) formatSample(changed.command)
  }
  const preventFocus = (event: React.MouseEvent) => event.preventDefault()
  return (
    <div className="flex flex-col gap-2" onMouseDownCapture={preventFocus}>
      <SimInspectorSection name="character-style" label="Character style">
        <div className="flex flex-wrap items-center gap-1">
          <ToggleGroup
            type="multiple"
            size="sm"
            aria-label="Character style"
            value={activeText.marks}
            onValueChange={(value) => marks(value, primary)}
          >
            {primary.map(({ command, label, icon: Icon }) => (
              <ToggleGroupItem
                key={command}
                value={command}
                aria-label={label}
                title={command === "italic" ? "Emphasis (<em>)" : label}
                className={SIM_ACCENT.pressedTool}
              >
                {Icon ? <Icon /> : <em>em</em>}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="More text formatting"
                title="More"
              >
                <Ellipsis />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-auto max-w-[calc(100vw-2rem)] p-2"
              onMouseDownCapture={preventFocus}
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              <ToggleGroup
                type="multiple"
                size="sm"
                aria-label="More character styles"
                value={activeText.marks}
                onValueChange={(value) => marks(value, more)}
              >
                {more.map(({ command, label, icon: Icon }) => (
                  <ToggleGroupItem
                    key={command}
                    value={command}
                    aria-label={label}
                    title={label}
                    className={SIM_ACCENT.pressedTool}
                  >
                    <Icon />
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </PopoverContent>
          </Popover>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Line break"
            title="Line break"
            onClick={() => formatSample("lineBreak")}
          >
            <CornerDownLeft />
          </Button>
        </div>
      </SimInspectorSection>
      {block && (
        <SimInspectorSection name="paragraph-style" label="Paragraph style">
          <ToggleGroup
            type="single"
            size="sm"
            aria-label="Text block"
            value={activeText.relativeHeading ?? activeText.block}
            onValueChange={(value) => {
              const command =
                value || activeText.relativeHeading || activeText.block
              if (blocks.some((item) => item.command === command))
                formatSample(command as PreviewInlineFormat)
            }}
          >
            {blocks.map(({ command, label, icon: Icon }) => {
              const result =
                command === "heading"
                  ? activeText.headingResult
                  : command === "subheading"
                    ? activeText.subheadingResult
                    : undefined
              const tooltip =
                command === "heading"
                  ? "Heading — one level below the block title"
                  : command === "subheading"
                    ? "Subheading — two levels below"
                    : label
              const resultLabel =
                result === "empty"
                  ? "—"
                  : result === "unavailable"
                    ? "Unavailable"
                    : result
              return (
                <ToggleGroupItem
                  key={command}
                  value={command}
                  className={SIM_ACCENT.pressedTool}
                  aria-label={resultLabel ? `${label} ${resultLabel}` : label}
                  title={tooltip}
                  disabled={result === "unavailable"}
                >
                  {Icon ? <Icon /> : <span>{resultLabel ?? label}</span>}
                </ToggleGroupItem>
              )
            })}
          </ToggleGroup>
        </SimInspectorSection>
      )}
    </div>
  )
}
