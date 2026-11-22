import type { ReactNode } from "react"
import {
  Accordion as AccordionRoot,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"

/** Bound content is resolved by the server renderer before these client
 * islands. No descriptor, context callback or editor write crosses the boundary.
 */
export type AccordionRow = {
  key: string
  title: ReactNode | null
  answer: ReactNode | null
  headingLevel: number
}

export function Accordion({
  rows,
  label,
}: {
  rows: AccordionRow[]
  label: string
}) {
  return (
    <AccordionRoot
      type="single"
      collapsible
      defaultValue={rows[0]?.key}
      aria-label={label}
    >
      {rows.map((row) =>
        row.title === null ? (
          row.answer === null ? null : (
            <div key={row.key} className="text-body text-on-surface-muted">
              {row.answer}
            </div>
          )
        ) : (
          <AccordionItem key={row.key} value={row.key}>
            <AccordionTrigger
              headingLevel={row.headingLevel}
              className="text-left text-lead font-medium text-on-surface"
            >
              {row.title}
            </AccordionTrigger>
            {row.answer !== null && (
              <AccordionContent forceMount>
                <div className="text-body text-on-surface-muted">
                  {row.answer}
                </div>
              </AccordionContent>
            )}
          </AccordionItem>
        )
      )}
    </AccordionRoot>
  )
}
