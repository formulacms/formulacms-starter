"use client"

import { HeadingSlot } from "@/components/slice-kit/heading-slot"
import * as React from "react"
import * as AccordionPrimitive from "@radix-ui/react-accordion"

import { cn } from "@/lib/utils"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"

function Accordion({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return (
    <AccordionPrimitive.Root
      data-slot="accordion"
      className={cn("flex w-full flex-col", className)}
      {...props}
    />
  )
}

function AccordionItem({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn("not-last:border-b", className)}
      {...props}
    />
  )
}

function AccordionTrigger({
  className,
  children,
  headingLevel = 3,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger> & {
  headingLevel?: number
}) {
  return (
    <AccordionPrimitive.Header asChild>
      <HeadingSlot level={headingLevel} className="flex">
        <AccordionPrimitive.Trigger
          data-slot="accordion-trigger"
          className={cn(
            "group/accordion-trigger relative flex flex-1 items-start justify-between rounded-md border border-transparent py-4 text-left text-sm font-medium transition-colors outline-none hover:underline focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:after:border-ring disabled:pointer-events-none disabled:opacity-50 **:data-[slot=accordion-trigger-icon]:ml-auto **:data-[slot=accordion-trigger-icon]:size-4 **:data-[slot=accordion-trigger-icon]:text-muted-foreground",
            className
          )}
          {...props}
        >
          {children}
          <ChevronDownIcon
            data-slot="accordion-trigger-icon"
            className="pointer-events-none shrink-0 group-aria-expanded/accordion-trigger:hidden"
          />
          <ChevronUpIcon
            data-slot="accordion-trigger-icon"
            className="pointer-events-none hidden shrink-0 group-aria-expanded/accordion-trigger:inline"
          />
        </AccordionPrimitive.Trigger>
      </HeadingSlot>
    </AccordionPrimitive.Header>
  )
}

function AccordionContent({
  className,
  children,
  forceMount,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  if (forceMount) {
    // A force-mounted closed panel keeps its children in the HTML and Radix
    // does not hide it, so CSS does. The grid row eases between 0fr and 1fr;
    // `visibility` hides the closed answer from view, Tab and screen readers
    // once the row has closed. Radix forces a 0s transition on its own node
    // while it measures, so the transition lives on the child grid instead.
    return (
      <AccordionPrimitive.Content
        data-slot="accordion-content"
        className="group/accordion-content overflow-hidden text-sm"
        forceMount
        {...props}
      >
        <div className="grid grid-rows-[0fr] transition-[grid-template-rows,visibility] duration-200 ease-out group-data-[state=open]/accordion-content:grid-rows-[1fr] group-data-[state=closed]/accordion-content:invisible motion-reduce:transition-none">
          <div className="min-h-0 overflow-hidden">
            <div
              className={cn(
                "pt-0 pb-4 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
                className
              )}
            >
              {children}
            </div>
          </div>
        </div>
      </AccordionPrimitive.Content>
    )
  }
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className="overflow-hidden text-sm data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down motion-reduce:animate-none"
      {...props}
    >
      <div
        className={cn(
          "h-(--radix-accordion-content-height) pt-0 pb-4 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
          className
        )}
      >
        {children}
      </div>
    </AccordionPrimitive.Content>
  )
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
