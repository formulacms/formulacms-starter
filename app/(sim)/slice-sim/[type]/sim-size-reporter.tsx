"use client"

import { useEffect } from "react"
import { postSimMessage } from "./sim-frame-bridge"

/**
 * Inside the `?bare=1` iframe, report the slice's intrinsic height to the
 * parent simulator so the iframe shrinks to fit the slice instead of forcing a
 * full-viewport `min-h-screen` page. Width stays at the breakpoint the parent
 * sets, so Tailwind's `sm:/md:/lg:` still resolves against a real viewport
 * width — only the height tracks the rendered content.
 */
export function SimSizeReporter() {
  useEffect(() => {
    function post() {
      const h = Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight
      )
      postSimMessage({ type: "size", height: h, width: window.innerWidth })
    }
    post()
    const ro = new ResizeObserver(() => post())
    ro.observe(document.body)
    window.addEventListener("load", post)
    window.addEventListener("resize", post)
    return () => {
      ro.disconnect()
      window.removeEventListener("load", post)
      window.removeEventListener("resize", post)
    }
  }, [])

  return null
}
