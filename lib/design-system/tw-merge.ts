import { extendTailwindMerge } from "tailwind-merge"

/**
 * The repository-wide Tailwind merger. These values mirror the Tailwind v4
 * theme namespaces in `app/globals.css`, allowing semantic design-system
 * utilities and default utilities to participate in the same conflict groups.
 */
export const mergeTailwindClasses = extendTailwindMerge({
  extend: {
    theme: {
      spacing: ["gutter", "stack", "section", "228"],
      text: ["display", "title", "heading", "lead", "body", "caption"],
      container: ["prose-content", "content", "wide"],
    },
  },
})
