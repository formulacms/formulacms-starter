import { formatLocalDateTime } from "@/lib/i18n/local-date-format"
import {
  usePageAddressMessages,
  type AddressAvailability,
} from "@/lib/admin/page-address-messages"
import { useFormatter, useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import type { Id } from "@/convex/_generated/dataModel"
import type { Locale } from "@/lib/i18n/config"
import { TagField } from "../../tag-field"
import {
  FieldLocaleActions,
  type FieldGenerate,
  type FieldTranslate,
} from "../../fields/field-editor"
import { slugify } from "../lib/content"
import type { Page, PageSummaryRow } from "../lib/types"
import {
  adminContentTypeLabel,
  adminContentTypeSingularMessageKey,
  adminContentTypes,
} from "@/lib/admin/content-types"
import { MultiRelationPicker } from "../../relation-picker"

type SettingsPanelProps = {
  page: Page
  currentLocale: Locale
  defaultLocale: Locale
  title: string
  slug: string
  slugLinked: boolean
  slugLocalizes: boolean
  slugIsSaved: boolean
  effectiveBaseSlug: string
  pageType: Page["pageType"]
  parentId: string
  authorIds: Id<"pages">[]
  tags: string[]
  parentOptions: PageSummaryRow[]
  addressAvailability?: AddressAvailability
  addressWasTyped?: boolean
  fieldSourceTitle: string
  fieldTranslate: FieldTranslate | undefined
  fieldGenerate: FieldGenerate | undefined
  onTitleChange(value: string): void
  onSlugChange(value: string): void
  onParentIdChange(value: string): void
  onAuthorIdsChange(value: Id<"pages">[]): void
  onTagsChange(value: string[]): void
  // Absent while the owner writes a new-language version: archiving or
  // deleting acts on the whole page, including the live site.
  onArchive?: () => void
  onDelete?: () => void
}

export function SettingsPanel({
  page,
  currentLocale,
  defaultLocale,
  title,
  slug,
  slugLinked,
  slugLocalizes,
  slugIsSaved,
  effectiveBaseSlug,
  pageType,
  parentId,
  authorIds,
  tags,
  parentOptions,
  addressAvailability,
  addressWasTyped,
  fieldSourceTitle,
  fieldTranslate,
  fieldGenerate,
  onTitleChange,
  onSlugChange,
  onParentIdChange,
  onAuthorIdsChange,
  onTagsChange,
  onArchive,
  onDelete,
}: SettingsPanelProps) {
  const addressMessages = usePageAddressMessages(defaultLocale)
  const addressEntry = addressAvailability?.entries.find(
    (entry) => entry.locale === currentLocale
  )
  const slugRefusal =
    (!slugLinked || addressWasTyped) &&
    !addressAvailability?.parentChanged &&
    addressEntry
      ? addressMessages.field(addressEntry.check, pageType)
      : null
  const numberedHint =
    !addressWasTyped && slug === addressEntry?.allocation?.allocatedSlug
      ? addressMessages.allocation(addressEntry, "S2b", null, pageType)
      : null
  const format = useFormatter()
  const t = useTranslations("editor.settings")
  const tPages = useTranslations("pages")
  const tList = useTranslations("pages.list")
  const tContentType = useTranslations("sidebar.contentType")
  // Non-routable content types (testimonial today — plan 029 C10) have no
  // public URL, so the slug field is hidden entirely in the editor. Their
  // storage row still carries an auto-generated internal handle
  // (`pages.slug`) for uniqueness; that's an implementation detail editors
  // don't need to see.
  const routable =
    adminContentTypes().find((t) => t.type === pageType)?.routable !== false
  const contentTypeMessageKey = adminContentTypeSingularMessageKey(pageType)
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <h2 className="text-sm font-medium text-muted-foreground">
        {t("heading")}
      </h2>
      <div className="divide-y rounded-lg border bg-card">
        <div className="space-y-1.5 p-4">
          <div className="flex min-h-5 items-center justify-between gap-2">
            <label
              htmlFor="settings-title"
              className="block text-sm font-medium"
            >
              {t("title")}{" "}
              <span className="text-xs font-normal text-muted-foreground">
                ({currentLocale.toUpperCase()})
              </span>
              {pageType === "testimonial" && (
                // Plan 029 C10 §Q9.b + ADR-0038 — testimonial title is
                // classified admin-only, used as the editor-facing
                // identifier ("Grace Hopper @ Yale, 1980"). Hint makes the
                // "never rendered publicly" behavior discoverable in the
                // Settings panel instead of a surprise at first publish.
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {t("internalIdentifier")}
                </span>
              )}
            </label>
            <FieldLocaleActions
              label={t("title")}
              sourceValue={fieldSourceTitle || undefined}
              currentValue={title}
              kind="text"
              translate={fieldTranslate}
              generate={fieldGenerate}
              onResult={onTitleChange}
            />
          </div>
          <input
            id="settings-title"
            type="text"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            placeholder={t("titlePlaceholder")}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
          />
        </div>

        {routable && (
          <div className="space-y-1.5 p-4">
            <label
              htmlFor="page-slug"
              className="flex items-center gap-2 text-sm font-medium"
            >
              <span>
                {t("slug")}{" "}
                <span className="text-xs font-normal text-muted-foreground">
                  ({currentLocale.toUpperCase()})
                </span>
              </span>
              {slugLocalizes && (
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${
                    slugIsSaved
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-amber-100 text-amber-700"
                  }`}
                >
                  {slugIsSaved ? t("saved") : t("notSaved")}
                </span>
              )}
            </label>
            <input
              id="page-slug"
              maxLength={80}
              type="text"
              value={slug}
              onChange={(e) => onSlugChange(e.target.value)}
              placeholder={slugify(title)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
            />
            <p className="text-xs text-muted-foreground">
              {slugLinked
                ? t("slugLinkedHint")
                : currentLocale === defaultLocale
                  ? t("defaultSlugHint")
                  : t("localizedSlugHint", {
                      locale: currentLocale.toUpperCase(),
                    })}
            </p>
            {currentLocale !== defaultLocale &&
              (slugLocalizes ? (
                <p
                  className={`text-xs font-medium ${
                    slugIsSaved ? "text-emerald-600" : "text-amber-600"
                  }`}
                >
                  {slugIsSaved
                    ? t("savedSlug", {
                        locale: currentLocale.toUpperCase(),
                        slug,
                      })
                    : t("unsavedSlug", {
                        locale: currentLocale.toUpperCase(),
                        slug,
                      })}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t("defaultLocaleSlug", { slug: effectiveBaseSlug })}
                </p>
              ))}
            {numberedHint && (
              <p className="text-xs text-muted-foreground">{numberedHint}</p>
            )}
            {slugRefusal && (
              <p role="alert" className="text-xs text-destructive">
                {slugRefusal}
              </p>
            )}
          </div>
        )}

        <div className="space-y-1.5 p-4">
          <p className="block text-sm font-medium">
            {tPages("contentType.label")}
          </p>
          <p className="text-sm">
            {contentTypeMessageKey && tContentType.has(contentTypeMessageKey)
              ? tContentType(contentTypeMessageKey)
              : adminContentTypeLabel(pageType).singular}
          </p>
          <p className="text-xs text-muted-foreground">
            {tPages("contentType.helpText")}
          </p>
        </div>

        <div className="space-y-1.5 p-4">
          <label htmlFor="page-parent" className="block text-sm font-medium">
            {t("parentPage")}
          </label>
          <select
            id="page-parent"
            value={parentId}
            onChange={(e) => onParentIdChange(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
          >
            <option value="">{t("noParent")}</option>
            {parentOptions.map((p) => {
              // Same current-locale → default-locale → slug fallback as
              // before; `listSummaries` resolves titles server-side into
              // `localizedTitles` so the full `content` bag never ships.
              const label =
                p.localizedTitles?.[currentLocale] ||
                p.localizedTitles?.[defaultLocale] ||
                p.slug
              const localeSlug =
                (currentLocale !== defaultLocale &&
                  p.localizedSlugs?.[currentLocale]) ||
                p.slug
              return (
                <option key={p._id} value={p._id}>
                  {label} (/{localeSlug})
                </option>
              )
            })}
          </select>
          <p className="text-xs text-muted-foreground">{t("parentHint")}</p>
          {addressAvailability?.parentChanged &&
            [...addressAvailability.entries]
              .sort(
                (a, b) =>
                  Number(b.locale === currentLocale) -
                  Number(a.locale === currentLocale)
              )
              .map((entry) => {
                const message = addressMessages.parent(
                  entry,
                  currentLocale,
                  pageType
                )
                return message ? (
                  <p
                    key={entry.locale}
                    role="alert"
                    className="text-xs text-destructive"
                  >
                    {message}
                  </p>
                ) : null
              })}
        </div>

        {pageType === "post" && (
          <div className="space-y-1.5 p-4">
            <p className="block text-sm font-medium">{t("authors")}</p>
            <MultiRelationPicker
              pageTypes={["author"]}
              value={authorIds}
              onChange={onAuthorIdsChange}
              locale={currentLocale}
              ariaLabel={t("postByline")}
            />
            <p className="text-xs text-muted-foreground">{t("authorsHint")}</p>
          </div>
        )}

        {pageType === "post" && (
          <div className="space-y-1.5 p-4">
            <label htmlFor="page-tags" className="block text-sm font-medium">
              {t("tags")}
            </label>
            <TagField id="page-tags" value={tags} onChange={onTagsChange} />
            <p className="text-xs text-muted-foreground">
              {t.rich("tagsHint", {
                code: (chunks) => <code>{chunks}</code>,
              })}
            </p>
          </div>
        )}

        <div className="space-y-1.5 p-4">
          <p className="block text-sm font-medium">{t("status")}</p>
          <Badge
            variant={
              page.status === "published"
                ? "default"
                : page.status === "archived"
                  ? "outline"
                  : "secondary"
            }
          >
            {tList(`status.${page.status}`)}
          </Badge>
        </div>

        <div className="space-y-1 p-4 text-xs text-muted-foreground">
          <p>
            {t("created", {
              date: formatLocalDateTime(format, page.createdAt),
            })}
          </p>
          <p>
            {t("updated", {
              date: formatLocalDateTime(format, page.updatedAt),
            })}
          </p>
        </div>

        {onArchive && onDelete && (
          <div className="space-y-2 p-4">
            {page.status === "archived" ? (
              <button
                type="button"
                onClick={onDelete}
                className="text-sm text-destructive hover:underline"
              >
                {t("moveToTrash")}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onArchive}
                  className="text-sm text-muted-foreground hover:text-foreground hover:underline"
                >
                  {t("archive")}
                </button>
                <p className="text-xs text-muted-foreground">
                  {t("archiveHint")}
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
