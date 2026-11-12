import type { ReactNode } from "react"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { PublicSurface } from "./public-surface"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./dialog"
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "./sheet"
import { Popover, PopoverContent, PopoverTrigger } from "./popover"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select"
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./alert-dialog"

// JSDOM has no layout/scroll implementation. Only provide the browser method
// required to mount our Select seam; its scrolling behavior is not under test.
const originalScrollIntoView = Element.prototype.scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {}
})
afterAll(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView
})
afterEach(cleanup)
const overlays: Array<[string, () => ReactNode]> = [
  [
    "dialog",
    () => (
      <Dialog defaultOpen>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent data-testid="overlay" showCloseButton={false}>
          <DialogTitle>Dialog</DialogTitle>
        </DialogContent>
      </Dialog>
    ),
  ],
  [
    "alert dialog",
    () => (
      <AlertDialog defaultOpen>
        <AlertDialogTrigger>Open</AlertDialogTrigger>
        <AlertDialogContent data-testid="overlay">
          <AlertDialogTitle>Alert</AlertDialogTitle>
          <AlertDialogDescription>Sure?</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>
    ),
  ],
  [
    "sheet",
    () => (
      <Sheet defaultOpen>
        <SheetTrigger>Open</SheetTrigger>
        <SheetContent data-testid="overlay" showCloseButton={false}>
          <SheetTitle>Sheet</SheetTitle>
        </SheetContent>
      </Sheet>
    ),
  ],
  [
    "popover",
    () => (
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent data-testid="overlay">Popover</PopoverContent>
      </Popover>
    ),
  ],
  [
    "dropdown",
    () => (
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent data-testid="overlay">
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  ],
  [
    "select",
    () => (
      <Select defaultOpen>
        <SelectTrigger>
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent data-testid="overlay">
          <SelectItem value="one">One</SelectItem>
        </SelectContent>
      </Select>
    ),
  ],
  [
    "tooltip",
    () => (
      <Tooltip defaultOpen>
        <TooltipTrigger>Open</TooltipTrigger>
        <TooltipContent data-testid="overlay">Tooltip</TooltipContent>
      </Tooltip>
    ),
  ],
]
function Locale({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider
      locale="en"
      messages={{ accessibility: { close: "Close" } }}
    >
      {children}
    </NextIntlClientProvider>
  )
}

describe("public overlay container seam", () => {
  test("forwards a design-system binding to its existing native host", () => {
    render(
      <PublicSurface data-register="editorial" className="owner-class">
        Content
      </PublicSurface>
    )
    const host = screen.getByText("Content")
    expect(host.tagName).toBe("DIV")
    expect(host).toHaveAttribute("data-public-ui", "")
    expect(host).toHaveAttribute("data-register", "editorial")
    expect(host).toHaveClass("owner-class")
  })
  test.each(overlays)(
    "%s stays in the public surface's same document",
    async (_name, overlay) => {
      render(
        <Locale>
          <PublicSurface data-testid="public">{overlay()}</PublicSurface>
        </Locale>
      )
      const content = await screen.findByTestId("overlay")
      expect(content.ownerDocument).toBe(document)
      expect(content.closest("[data-public-ui]")).toBe(
        screen.getByTestId("public")
      )
    }
  )
  test.each(overlays)(
    "%s keeps the existing admin portal default",
    async (_name, overlay) => {
      render(<Locale>{overlay()}</Locale>)
      const content = await screen.findByTestId("overlay")
      expect(document.body.contains(content)).toBe(true)
      expect(content.closest("[data-public-ui]")).toBeNull()
    }
  )
  test("a nested themed public region owns its portal instead of escaping into its parent", async () => {
    render(
      <PublicSurface data-testid="outer">
        <PublicSurface className="dark" data-testid="inner">
          <Popover defaultOpen>
            <PopoverTrigger>Open</PopoverTrigger>
            <PopoverContent data-testid="overlay">Content</PopoverContent>
          </Popover>
        </PublicSurface>
      </PublicSurface>
    )
    await waitFor(() =>
      expect(screen.getByTestId("overlay").closest("[data-public-ui]")).toBe(
        screen.getByTestId("inner")
      )
    )
  })
})
