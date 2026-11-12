"use client"

import { useMutation } from "convex/react"
import { useTranslations } from "next-intl"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { hasErrorCode } from "./pages-list-errors"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"

function createDuplicatePageSchema(titleRequired: string) {
  return z.object({
    title: z.string().trim().min(1, titleRequired),
  })
}

type DuplicatePageValues = z.input<
  ReturnType<typeof createDuplicatePageSchema>
>

export function DuplicatePageDialog({
  pageId,
  sourceTitle,
  beforeDuplicate,
  onCloseAutoFocus,
  onDuplicated,
  onClose,
}: {
  pageId: Id<"pages">
  sourceTitle: string
  beforeDuplicate?: () => boolean | Promise<boolean>
  /** Radix hook that runs when the dialog closes, before focus returns to
   *  whatever opened it; calling `preventDefault` lets the caller place focus. */
  onCloseAutoFocus?: (event: Event) => void
  onDuplicated: (pageId: Id<"pages">) => void
  onClose: () => void
}) {
  const displayError = useCaughtError()
  const t = useTranslations("editor.duplicateDialog")
  const duplicatePage = useMutation(api.cms.pages.duplicate)
  const form = useForm<DuplicatePageValues>({
    resolver: zodResolver(createDuplicatePageSchema(t("titleRequired"))),
    defaultValues: {
      title: t("copyTitle", { title: sourceTitle.trim() || t("untitled") }),
    },
  })
  const isSubmitting = form.formState.isSubmitting

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && !isSubmitting) onClose()
  }

  const handleSubmit = form.handleSubmit(async (values) => {
    const confirmedTitle = values.title.trim()
    let duplicatedPageId: Id<"pages">
    try {
      if (beforeDuplicate && !(await beforeDuplicate())) return
      duplicatedPageId = await duplicatePage({
        id: pageId,
        title: confirmedTitle,
      })
    } catch (cause) {
      // Snapshot publication cannot duplicate pages yet (a separate unit).
      // Say so plainly instead of offering a retry; never report success.
      if (hasErrorCode(cause, "LEGACY_PUBLICATION_WRITER_DISABLED")) {
        onClose()
        toast.error(t("unavailable"))
        return
      }
      // A failed duplicate is about the whole operation, not the title field.
      form.setError("root", {
        message: displayError(cause, t("failed")),
      })
      return
    }
    onClose()
    toast.success(t("created", { title: confirmedTitle }))
    onDuplicated(duplicatedPageId)
  })

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-sm"
        showCloseButton={!isSubmitting}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <Form {...form}>
          <form onSubmit={handleSubmit} noValidate>
            <DialogHeader>
              <DialogTitle>{t("title")}</DialogTitle>
              <DialogDescription>{t("description")}</DialogDescription>
            </DialogHeader>

            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem className="mt-4">
                  <FormLabel>{t("newTitle")}</FormLabel>
                  <FormControl>
                    <Input
                      // The title is the only decision in this modal, so opening
                      // it directly on the preselected value is the expected
                      // keyboard UX.
                      // eslint-disable-next-line jsx-a11y/no-autofocus
                      autoFocus
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {form.formState.errors.root && (
              <p role="alert" className="mt-1.5 text-xs text-destructive">
                {form.formState.errors.root.message}
              </p>
            )}

            <DialogFooter className="mt-6">
              <Button
                type="button"
                variant="outline"
                disabled={isSubmitting}
                onClick={onClose}
              >
                {t("cancel")}
              </Button>
              {/* Not disabled on an empty title: the zod rule says why in the
                field, which a dead button cannot. */}
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="size-4 animate-spin" />}
                {isSubmitting ? t("duplicating") : t("action")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
