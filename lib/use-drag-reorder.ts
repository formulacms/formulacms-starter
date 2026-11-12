"use client"

import { useState } from "react"

/** Move an item within an array, returning a new array. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length
  ) {
    return items
  }
  const next = items.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/**
 * Native HTML5 drag-and-drop reordering. The caller supplies `onReorder` to
 * apply the move; this hook tracks the dragged index and yields the props each
 * draggable row needs.
 */
export function useDragReorder(
  onReorder: (from: number, to: number) => void,
  keyboard?: {
    count: number
    announce: (
      action: "grab" | "movePosition" | "drop" | "cancel",
      from: number,
      to: number
    ) => string
  }
) {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  const [keyboardFrom, setKeyboardFrom] = useState<number | null>(null)
  const [keyboardTo, setKeyboardTo] = useState<number | null>(null)
  const [announcement, setAnnouncement] = useState("")

  // Opt-in handle props: existing callers retain their native drag API.
  function keyboardHandlers(index: number) {
    if (!keyboard) return {}
    return {
      "aria-pressed": keyboardFrom === index,
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.nativeEvent.isComposing) return
        if (![" ", "ArrowUp", "ArrowDown", "Escape"].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        if (event.key === " " && keyboardFrom === null) {
          setKeyboardFrom(index)
          setKeyboardTo(index)
          setAnnouncement(keyboard.announce("grab", index, index))
          return
        }
        if (keyboardFrom !== index || keyboardTo === null) return
        if (event.key === "Escape" || event.key === " ") {
          const cancel = event.key === "Escape"
          if (!cancel && keyboardFrom !== keyboardTo)
            onReorder(keyboardFrom, keyboardTo)
          setAnnouncement(
            keyboard.announce(
              cancel ? "cancel" : "drop",
              index,
              cancel ? index : keyboardTo
            )
          )
          setKeyboardFrom(null)
          setKeyboardTo(null)
        } else {
          const next = Math.max(
            0,
            Math.min(
              keyboard.count - 1,
              keyboardTo + (event.key === "ArrowUp" ? -1 : 1)
            )
          )
          setKeyboardTo(next)
          setAnnouncement(keyboard.announce("movePosition", index, next))
        }
      },
    }
  }

  function dragHandlers(index: number) {
    return {
      draggable: true,
      onDragStart: (event?: React.DragEvent) => {
        if (keyboard) event?.stopPropagation()
        setDragIndex(index)
      },
      onDragEnter: (event?: React.DragEvent) => {
        if (keyboard) event?.stopPropagation()
        setOverIndex(index)
      },
      onDragOver: (e: React.DragEvent) => e.preventDefault(),
      onDrop: (event?: React.DragEvent) => {
        if (keyboard) event?.stopPropagation()
        if (dragIndex !== null && dragIndex !== index)
          onReorder(dragIndex, index)
        setDragIndex(null)
        setOverIndex(null)
      },
      onDragEnd: () => {
        setDragIndex(null)
        setOverIndex(null)
      },
    }
  }

  return { dragIndex, overIndex, dragHandlers, keyboardHandlers, announcement }
}
