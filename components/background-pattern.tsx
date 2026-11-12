"use client"

import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import DotPattern from "@/components/ui/dot-pattern"
import Particles from "@/components/ui/particles"
import { cn } from "@/lib/utils"

export const BackgroundPattern = () => {
  const { resolvedTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setMounted(true)
    })

    return () => {
      cancelAnimationFrame(frame)
    }
  }, [])

  if (!mounted) {
    return null
  }

  const isLightTheme = resolvedTheme === "light"

  return (
    <>
      <DotPattern
        className={cn(
          "background-pattern-mask",
          "dark:fill-slate-700"
        )}
        cr={1}
        cx={1}
        cy={1}
        height={20}
        width={20}
      />
      <Particles
        className="absolute inset-0"
        color={isLightTheme ? "#000" : "#fff"}
        ease={80}
        quantity={100}
        refresh
      />
    </>
  )
}
