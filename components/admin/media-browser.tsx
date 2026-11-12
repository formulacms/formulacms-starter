"use client"

import { useRef, useState, type ClipboardEvent } from "react"
import { useTranslations } from "next-intl"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import Image from "next/image"
import { useQuery, useMutation, usePaginatedQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { Doc } from "@/convex/_generated/dataModel"
import { useMediaUpload } from "@/lib/media/use-media-upload"
import { usePrompt } from "@/components/providers/confirm-provider"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import {
  ADMIN_LIST_SEARCH_BROWSER_BINDING,
  type AdminListSearchResult,
} from "./contributions/list-search"
import {
  ClipboardPaste,
  Folder,
  FolderPlus,
  ImageIcon,
  Link2,
  Upload,
} from "lucide-react"

export type Media = Doc<"media">

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  )
}

function clipboardFiles(data: DataTransfer): File[] {
  const files = Array.from(data.files).filter((file) =>
    file.type.startsWith("image/")
  )
  if (files.length > 0) return files

  const pastedFiles: File[] = []
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue
    const file = item.getAsFile()
    if (!file) continue
    pastedFiles.push(
      file.name
        ? file
        : new File(
            [file],
            `pasted-image-${pastedFiles.length + 1}.${
              file.type.split("/")[1] ?? "png"
            }`,
            { type: file.type }
          )
    )
  }

  return pastedFiles
}

function looksLikeImageUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    return /\.(avif|gif|jpe?g|png|svg|webp)(\?.*)?$/i.test(url.href)
  } catch {
    return false
  }
}

function clipboardFilename(type: string, index: number): string {
  const extension = type.split("/")[1] || "png"
  return `clipboard-image-${index + 1}.${extension}`
}

type MediaBrowserProps = {
  onItemClick: (media: Media) => void
  selectedId?: string
}

const NO_MEDIA_SEARCH: AdminListSearchResult<Media> = {
  control: null,
  query: "",
  results: undefined,
  reset: () => {},
}

/**
 * Shared browsing surface for the media library and the media picker: folder
 * sidebar, search, upload, and a thumbnail grid. `onItemClick` lets the host
 * decide what selecting an item does (open detail vs. return for a field).
 */
export function MediaBrowser(props: MediaBrowserProps) {
  const [folder, setFolder] = useState<string | undefined>(undefined)
  // Full-text search is a Search (M04) list control reached only through its
  // binding; without a participant the folder-scoped paginated list remains
  // the whole surface.
  const SearchSlot = ADMIN_LIST_SEARCH_BROWSER_BINDING?.MediaSlot
  if (!SearchSlot) {
    return (
      <MediaBrowserSurface
        {...props}
        folder={folder}
        setFolder={setFolder}
        search={NO_MEDIA_SEARCH}
      />
    )
  }
  return (
    <SearchSlot folder={folder}>
      {(search) => (
        <MediaBrowserSurface
          {...props}
          folder={folder}
          setFolder={setFolder}
          search={search}
        />
      )}
    </SearchSlot>
  )
}

function MediaBrowserSurface({
  onItemClick,
  selectedId,
  folder,
  setFolder,
  search,
}: MediaBrowserProps & {
  folder: string | undefined
  setFolder: (folder: string | undefined) => void
  search: AdminListSearchResult<Media>
}) {
  const displayError = useCaughtError()
  const t = useTranslations("editor.mediaBrowser")
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const folders = useQuery(api.cms.media.listFolders, {}) ?? []
  const isSearching = search.query !== ""
  const searchResults = search.results
  const paginated = usePaginatedQuery(
    api.cms.media.listPaginated,
    isSearching ? "skip" : { folder },
    { initialNumItems: 30 }
  )
  const createFolder = useMutation(api.cms.media.createFolder)
  const { uploadMany, importFromUrl, isUploading } = useMediaUpload()
  const prompt = usePrompt()

  const isLoading = isSearching
    ? searchResults === undefined
    : paginated.status === "LoadingFirstPage"
  const filtered = isSearching ? (searchResults ?? []) : paginated.results
  const canLoadMore = !isSearching && paginated.status === "CanLoadMore"
  const isLoadingMore = !isSearching && paginated.status === "LoadingMore"

  async function handleFiles(files: FileList | File[] | null) {
    const fileList = files ? Array.from(files) : []
    if (fileList.length === 0) return
    try {
      const ids = await uploadMany(fileList, folder)
      toast.success(t("uploaded", { count: ids.length }))
    } catch (err) {
      toast.error(displayError(err, t("uploadFailed")))
    }
  }

  async function handleImportUrl(rawUrl: string) {
    const url = rawUrl.trim()
    if (!url) return
    try {
      await importFromUrl(url, { folder })
      toast.success(t("imported"))
    } catch (err) {
      toast.error(displayError(err, t("importFailed")))
    }
  }

  async function handleManualUrlImport() {
    const url = await prompt({
      title: t("importUrlTitle"),
      label: t("imageUrl"),
      placeholder: t("urlPlaceholder"),
      confirmText: t("importAction"),
    })
    if (!url) return
    await handleImportUrl(url)
  }

  async function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    const files = clipboardFiles(event.clipboardData)
    if (files.length > 0) {
      event.preventDefault()
      await handleFiles(files)
      return
    }

    if (isEditableElement(event.target)) return

    const text = event.clipboardData.getData("text/plain").trim()
    if (looksLikeImageUrl(text)) {
      event.preventDefault()
      await handleImportUrl(text)
    }
  }

  async function handleClipboardButton() {
    try {
      if (navigator.clipboard?.read) {
        const items = await navigator.clipboard.read()
        const imageItems = items.flatMap((item) =>
          item.types.flatMap((type) =>
            type.startsWith("image/") ? [{ item, type }] : []
          )
        )
        const files = await Promise.all(
          imageItems.map(async ({ item, type }, index) => {
            const blob = await item.getType(type)
            return new File([blob], clipboardFilename(type, index), { type })
          })
        )
        if (files.length > 0) {
          await handleFiles(files)
          return
        }
      }

      const text = await navigator.clipboard?.readText?.()
      if (text && looksLikeImageUrl(text)) {
        await handleImportUrl(text)
        return
      }

      toast.error(t("clipboardEmpty"))
    } catch (err) {
      toast.error(
        displayError(err, t("clipboardFailed"))
      )
    }
  }

  async function handleNewFolder() {
    const name = await prompt({
      title: t("newFolder"),
      label: t("folderName"),
      placeholder: t("folderPlaceholder"),
      confirmText: t("createFolder"),
    })
    if (!name) return
    try {
      await createFolder({ name, parentFolder: folder })
      toast.success(t("folderCreated"))
    } catch (err) {
      toast.error(
        displayError(err, t("folderFailed"))
      )
    }
  }

  return (
    <div
      className={`flex h-full min-h-0 gap-4 rounded-md outline-none ${
        isDragOver ? "ring-2 ring-ring ring-offset-2" : ""
      }`}
      onPaste={handlePaste}
      onDragOver={(event) => {
        event.preventDefault()
        setIsDragOver(true)
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setIsDragOver(false)
        handleFiles(event.dataTransfer.files)
      }}
    >
      {/* Folder sidebar */}
      <aside className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r pr-3">
        <button
          type="button"
          onClick={() => setFolder(undefined)}
          className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
            folder === undefined
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/50"
          }`}
        >
          <ImageIcon className="size-4 shrink-0" />
          {t("allMedia")}
        </button>
        {folders.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFolder(f)}
            className={`flex items-center gap-2 truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
              folder === f
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50"
            }`}
            title={f}
          >
            <Folder className="size-4 shrink-0" />
            <span className="truncate">{f}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={handleNewFolder}
          className="mt-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50"
        >
          <FolderPlus className="size-4 shrink-0" />
          {t("newFolder")}
        </button>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {search.control ?? <div className="flex-1" />}
          <input
            ref={fileInput}
            type="file"
            aria-label={t("uploadMedia")}
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              handleFiles(e.target.files)
              e.target.value = ""
            }}
          />
          <button
            type="button"
            onClick={handleClipboardButton}
            disabled={isUploading}
            title={t("pasteTitle")}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            <ClipboardPaste className="size-3.5" />
            {t("paste")}
          </button>
          <button
            type="button"
            onClick={handleManualUrlImport}
            disabled={isUploading}
            title={t("importUrlTitle")}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            <Link2 className="size-3.5" />
            {t("url")}
          </button>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={isUploading}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            <Upload className="size-3.5" />
            {isUploading ? t("uploading") : t("uploadFiles")}
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <p className="p-4 text-sm text-muted-foreground">
              {t("loading")}
            </p>
          ) : filtered.length === 0 ? (
            <div className="rounded-lg border border-dashed p-10 text-center">
              <p className="text-sm text-muted-foreground">
                {isSearching
                  ? t("noSearchMatches")
                  : t("empty")}
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                {filtered.map((m) => (
                  <button
                    key={m._id}
                    type="button"
                    onClick={() => onItemClick(m)}
                    className={`group relative aspect-square overflow-hidden rounded-lg border bg-muted text-left transition-colors hover:border-ring focus:ring-1 focus:ring-ring focus:outline-none ${
                      selectedId === m._id ? "ring-2 ring-ring" : ""
                    }`}
                    title={m.filename}
                  >
                    <Image
                      src={m.url}
                      alt=""
                      fill
                      className="object-cover"
                      sizes="96px"
                    />
                    <span className="absolute inset-x-0 bottom-0 truncate bg-black/50 px-2 py-1 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                      {m.filename}
                    </span>
                  </button>
                ))}
              </div>
              {canLoadMore && (
                <div className="flex justify-center py-4">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => paginated.loadMore(30)}
                    disabled={isLoadingMore}
                  >
                    {isLoadingMore ? t("loading") : t("loadMore")}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
