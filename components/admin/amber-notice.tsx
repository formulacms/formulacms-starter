import type { ReactNode } from "react"
import { CircleAlert } from "lucide-react"

/**
 * The amber notice of the admin: Help's notices, the messages shown when a
 * local-tool assistant is used from another device (image 4, a to c), and the
 * page editor's "Not shown on the site" notice. One component, so every such
 * message looks the same. Core code, not AI: the editor shows it with AI off.
 */
export function AmberNotice({
  testId,
  children,
}: {
  testId: string
  children: ReactNode
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      data-slot="amber-notice"
      className="flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2.5 text-sm text-amber-900 dark:text-amber-200"
    >
      <CircleAlert className="size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  )
}
