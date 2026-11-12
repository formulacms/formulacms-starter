"use client"

import { createContext, useContext, useState, type ComponentProps } from "react"

// undefined retains Radix's document.body default for admin consumers. null is
// a public surface whose same-document host has not mounted yet; never portal
// into the admin document body while waiting for that host.
const PublicPortalContainer = createContext<HTMLElement | null | undefined>(
  undefined
)

/** A public region owns both its tokens and the DOM destination of its portals.
 * Keep the existing host's geometry/classes; do not introduce a portal layer
 * with transforms, containment, or a stacking context. Server children remain
 * server-rendered across this small client boundary. */
export function PublicSurface({
  children,
  ...props
}: Omit<ComponentProps<"div">, "ref">) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <PublicPortalContainer.Provider value={container}>
      <div {...props} data-public-ui="" ref={setContainer}>
        {children}
      </div>
    </PublicPortalContainer.Provider>
  )
}

export function usePublicPortalContainer() {
  return useContext(PublicPortalContainer)
}
