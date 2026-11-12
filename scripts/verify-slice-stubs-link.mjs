import { createElement } from "react"

function Link({ href, children, className, target, rel, download }) {
  return createElement(
    "a",
    {
      href: typeof href === "string" ? href : href?.pathname ?? "#",
      className,
      target,
      rel,
      ...(download ? { download: "" } : {}),
    },
    children,
  )
}

export default Link

export function useLinkStatus() {
  return { pending: false }
}
