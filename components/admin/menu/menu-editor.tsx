"use client"

import { isColumnPanel, panelBlocks, type LocaleBlock } from "@/convex/lib/menu"

import { getContentDefault } from "@/lib/i18n/content-defaults"

import { useEffect, useId, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useConfirm } from "@/components/providers/confirm-provider"
import {
  hasMenuText,
  menuDraftEqual,
  menuErrors,
  menuTextValid,
  type TargetIntent,
} from "@/lib/admin/menu/validation"
import {
  EmptyLocaleIcon,
  MenuValidationContext,
  useMenuReorder,
} from "./menu-validation"
import { MenuPublicationNotice } from "./menu-target-field"
import { useMutation, useQuery } from "convex/react"
import {
  ArrowLeft,
  CircleAlert,
  ChevronDown,
  ChevronUp,
  Copy,
  Loader2,
  Plus,
  Save,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import { generateMenuId, type LocaleNavItem } from "@/convex/lib/menu"
import type { Locale } from "@/lib/i18n/config"
import {
  localesWithMenuText,
  mergeLocale,
  projectLocale,
  replaceDefaultLocale,
  retainAuthoredAlt,
  withAuthoredAlt,
} from "@/lib/admin/menu/locale-projection"
import { moveItem } from "@/lib/use-drag-reorder"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { LocaleTabs } from "@/components/admin/locale-tabs"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { CanonicalNavItemEditor } from "./canonical-nav-item-editor"

interface MenuEditorProps {
  slug: string
}

interface MenuEditorDraft {
  locale: Locale
  expectedUpdatedAt: number | null
  values: LocaleNavItem[]
  placeholders: LocaleNavItem[] | null
}

function newNavItem(locale: string): LocaleNavItem {
  return { id: generateMenuId(), label: getContentDefault(locale, "menuItem") }
}

export function MenuEditor({ slug }: MenuEditorProps) {
  const t = useTranslations("menus.editor")
  const tList = useTranslations("menus.list")
  const confirm = useConfirm()
  const router = useRouter()
  const editorRef = useRef<HTMLDivElement>(null)
  const [intents, setIntents] = useState<Record<string, TargetIntent>>({})
  const [attempt, setAttempt] = useState(0)
  const [focusRequest, setFocusRequest] = useState<{ key: string } | null>(null)
  const siteConfig = useQuery(api.cms.settings.getSiteConfig)
  const owner = useQuery(api.cms.owner.getOwnerSession)
  const ownerResolved = owner !== undefined && owner !== null
  const canList = ownerResolved
  const canUpdate = ownerResolved
  const enabledLocales = (siteConfig?.enabledLocales ?? []) as Locale[]
  const defaultLocale = siteConfig?.defaultLocale as Locale | undefined
  const [locale, setLocale] = useState<Locale | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [draft, setDraft] = useState<MenuEditorDraft | null>(null)
  const activeLocale = draft?.locale ?? locale ?? defaultLocale
  const menu = useQuery(api.cms.menus.getCanonical, canList ? { slug } : "skip")
  const saveMenu = useMutation(api.cms.menus.saveCanonical)
  const canonicalNav = menu?.nav ?? []
  const savedNav =
    activeLocale && defaultLocale
      ? projectLocale(canonicalNav, activeLocale, defaultLocale)
      : []
  const defaultNav = defaultLocale
    ? projectLocale(canonicalNav, defaultLocale, defaultLocale)
    : []
  const savedDraft: MenuEditorDraft | null =
    activeLocale && defaultLocale && menu !== undefined
      ? {
          locale: activeLocale,
          expectedUpdatedAt: menu?.updatedAt ?? null,
          values: savedNav,
          placeholders: activeLocale === defaultLocale ? null : defaultNav,
        }
      : null
  const activeDraft = draft ?? savedDraft
  const nav = activeDraft?.values ?? []
  const errors = menuErrors(nav, intents)
  const hasChanges =
    !menuDraftEqual(nav, savedNav) ||
    errors.some((error) => error.code === "page")
  const menuName =
    slug === "primary" || slug === "footer"
      ? tList(`defaults.${slug}.name`)
      : slug
  const menuDescription =
    slug === "primary" || slug === "footer"
      ? tList(`defaults.${slug}.description`)
      : t("description", { slug })
  useEffect(() => {
    document.title = menuName
  }, [menuName])
  useEffect(() => {
    if (!focusRequest) return
    const field = Array.from(
      editorRef.current?.querySelectorAll<HTMLElement>("[data-menu-field]") ??
        []
    ).find(
      (element) =>
        element.dataset.menuField === focusRequest.key &&
        Boolean(element.querySelector("input,button"))
    )
    const control = field?.matches("input,button")
      ? field
      : field?.querySelector<HTMLElement>("input,button")
    control?.focus()
  }, [focusRequest])
  useEffect(() => {
    if (!hasChanges) return
    function beforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", beforeUnload)
    return () => window.removeEventListener("beforeunload", beforeUnload)
  }, [hasChanges])
  const canEditStructure = activeLocale === defaultLocale
  const availableText = localesWithMenuText(canonicalNav)
  const availableLocales = enabledLocales.filter((candidate) =>
    availableText.has(candidate)
  )
  const sourceLocales = availableLocales.filter(
    (candidate) => candidate !== activeLocale
  )
  const { dragHandlers, handle, feedback } = useMenuReorder(
    (from, to) => {
      if (canEditStructure) setNav(moveItem(nav, from, to))
    },
    nav.map((item) => item.label)
  )

  function setNav(next: LocaleNavItem[]) {
    if (!canUpdate || !savedDraft) return
    setDraft((current) => {
      const previous = current ?? savedDraft
      return {
        ...previous,
        values: retainAuthoredAlt(previous.values, next),
      }
    })
  }

  async function handleLocaleChange(next: Locale) {
    if (next === activeLocale) return
    if (hasChanges && !(await confirm({ title: t("discardConfirm") }))) return
    setDraft(null)
    setIntents({})
    setAttempt(0)
    setLocale(next)
  }

  async function handleCopyFromLocale(source: Locale) {
    if (!activeLocale || !defaultLocale) return
    if (
      activeLocale !== defaultLocale &&
      hasMenuText(nav) &&
      !(await confirm({
        title: t("copyOverwrite", {
          locale: activeLocale.toUpperCase(),
          source: source.toUpperCase(),
        }),
      }))
    )
      return
    setIntents({})
    setAttempt(0)
    const sourceProjection = projectLocale(canonicalNav, source, defaultLocale)
    const copiedCanonical = mergeLocale(
      canonicalNav,
      activeLocale,
      sourceProjection
    )
    setNav(projectLocale(copiedCanonical, activeLocale, defaultLocale))
    toast.success(t("copied", { locale: source.toUpperCase() }))
  }

  async function handleSave() {
    if (!canUpdate || !draft || !hasChanges || !activeLocale || !defaultLocale)
      return
    if (canEditStructure && errors.length) {
      setAttempt((current) => current + 1)
      setFocusRequest({ key: errors[0]!.key })
      toast.error(t("invalidFields"), {
        icon: <CircleAlert className="size-4 text-destructive" />,
      })
      return
    }
    const submittedDraft = draft
    setIsSaving(true)
    try {
      const nextCanonical =
        activeLocale === defaultLocale
          ? replaceDefaultLocale(
              canonicalNav,
              defaultLocale,
              submittedDraft.values
            )
          : mergeLocale(canonicalNav, activeLocale, submittedDraft.values)
      if (!menuTextValid(nextCanonical)) {
        toast.error(t("invalidFields"), {
          icon: <CircleAlert className="size-4 text-destructive" />,
        })
        return
      }
      const saved = await saveMenu({
        slug,
        locale: submittedDraft.locale,
        nav: nextCanonical,
        expectedUpdatedAt: submittedDraft.expectedUpdatedAt,
      })
      setDraft((current) =>
        current === submittedDraft || current === null
          ? null
          : { ...current, expectedUpdatedAt: saved.updatedAt }
      )
      toast.success(t("saved"))
    } catch {
      toast.error(t("saveFailed"))
    } finally {
      setIsSaving(false)
    }
  }

  const heading = (
    <div className="space-y-1">
      <Link
        href="/admin/menus"
        onClick={async (event) => {
          if (
            !hasChanges ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return
          event.preventDefault()
          if (await confirm({ title: t("leaveConfirm") }))
            router.push("/admin/menus")
        }}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3" />
        {t("back")}
      </Link>
      <h1 className="text-2xl font-semibold">{menuName}</h1>
      <p className="text-sm text-muted-foreground">{menuDescription}</p>
    </div>
  )

  if (owner === undefined) {
    return <StateMessage heading={heading} message={t("loadingAccess")} />
  }
  if (!canList) {
    return <StateMessage heading={heading} message={t("noAccess")} />
  }
  if (menu === undefined || !savedDraft || !activeLocale || !defaultLocale) {
    return <StateMessage heading={heading} message={t("loading")} />
  }

  if (!canUpdate) {
    return (
      <div className="max-w-3xl space-y-6">
        {heading}
        <div className="rounded-lg border bg-muted/30 p-4">
          <p className="font-medium">{t("viewOnly")}</p>
          <p className="text-sm text-muted-foreground">
            {t("viewOnlyDescription")}
          </p>
        </div>
        <LocaleTabs
          currentLocale={activeLocale}
          enabledLocales={enabledLocales}
          availableLocales={availableLocales}
          onLocaleChange={handleLocaleChange}
        />
        <ReadOnlyMenuTree nav={nav} />
      </div>
    )
  }

  return (
    <div ref={editorRef} className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        {heading}
        <div className="flex items-center gap-2">
          {hasChanges && (
            <span className="text-xs text-amber-600">
              {t("unsavedChanges")}
            </span>
          )}
          {sourceLocales.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={isSaving}>
                  <Copy className="size-4" />
                  {t("copyFrom")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {sourceLocales.map((source) => (
                  <DropdownMenuItem
                    key={source}
                    onClick={() => handleCopyFromLocale(source)}
                  >
                    <Copy className="size-4" />
                    {t("copyFromLocale", { locale: source.toUpperCase() })}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button onClick={handleSave} disabled={!hasChanges || isSaving}>
            {isSaving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            {t("save")}
          </Button>
        </div>
      </div>

      <LocaleTabs
        currentLocale={activeLocale}
        enabledLocales={enabledLocales}
        availableLocales={availableLocales}
        onLocaleChange={handleLocaleChange}
        disabled={isSaving}
      />

      <MenuValidationContext.Provider
        value={{
          attempt,
          errors,
          intents,
          setIntent: (key, intent) => {
            setIntents((current) => ({ ...current, [key]: intent }))
            setDraft((current) => current ?? savedDraft)
          },
        }}
      >
        {canEditStructure && feedback}
        <div className="space-y-4">
          {nav.map((item, index) => (
            <div
              key={item.id}
              {...(canEditStructure ? dragHandlers(index) : {})}
            >
              {canEditStructure ? (
                <CanonicalNavItemEditor
                  item={item}
                  dragHandle={handle(index)}
                  locale={activeLocale}
                  onChange={(updated) =>
                    setNav(
                      nav.map((current) =>
                        current.id === item.id ? updated : current
                      )
                    )
                  }
                  onDelete={async () => {
                    if (
                      await confirm({
                        title: t("deleteItemConfirm"),
                        destructive: true,
                      })
                    )
                      setNav(nav.filter((current) => current.id !== item.id))
                  }}
                  onMoveUp={() => setNav(moveItem(nav, index, index - 1))}
                  onMoveDown={() => setNav(moveItem(nav, index, index + 1))}
                  isFirst={index === 0}
                  isLast={index === nav.length - 1}
                />
              ) : (
                <LocalizedNavItemEditor
                  item={item}
                  locale={activeLocale}
                  authoredAltIds={panelBlocks(canonicalNav[index]?.panel)
                    .map((entry) => entry.block)
                    .filter(
                      (block) =>
                        block.kind === "featured" &&
                        Boolean(
                          block.image &&
                          Object.hasOwn(block.image.alt, activeLocale)
                        )
                    )
                    .map((block) => block.id)}
                  placeholder={activeDraft?.placeholders?.[index]}
                  onChange={(updated) =>
                    setNav(
                      nav.map((current) =>
                        current.id === item.id ? updated : current
                      )
                    )
                  }
                />
              )}
            </div>
          ))}

          {canEditStructure && (
            <Button
              variant="outline"
              onClick={() => setNav([...nav, newNavItem(activeLocale)])}
              className="w-full"
            >
              <Plus className="size-4" />
              {t("addItem")}
            </Button>
          )}

          {nav.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("empty")}
            </p>
          )}
        </div>
      </MenuValidationContext.Provider>
    </div>
  )
}

function LocalizedNavItemEditor({
  item,
  locale,
  authoredAltIds,
  placeholder,
  onChange,
}: {
  item: LocaleNavItem
  locale: string
  authoredAltIds: string[]
  placeholder: LocaleNavItem | undefined
  onChange: (item: LocaleNavItem) => void
}) {
  const t = useTranslations("menus.navigationItem")
  const tEmpty = useTranslations("menus.emptyText")
  const tPanel = useTranslations("menus.panel")
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      className={`overflow-hidden rounded-lg border bg-card ${item.isDisabled ? "opacity-50" : ""}`}
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <div className="relative flex-1">
          <Input
            value={item.label}
            onChange={(event) =>
              onChange({ ...item, label: event.target.value })
            }
            placeholder={placeholder?.label || t("labelPlaceholder")}
            className="h-8 pr-8 font-medium"
            aria-label={t("labelPlaceholder")}
          />
          {!item.label.trim() && (
            <EmptyLocaleIcon
              message={tEmpty("item", { locale: locale.toUpperCase() })}
            />
          )}
        </div>
        {item.isDisabled && <Badge variant="secondary">{t("disabled")}</Badge>}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() => setExpanded((current) => !current)}
          aria-label={expanded ? t("collapse") : t("expand")}
        >
          {expanded ? (
            <ChevronUp className="size-4" />
          ) : (
            <ChevronDown className="size-4" />
          )}
        </Button>
      </div>

      <div className="px-3">
        <MenuPublicationNotice target={item.target} />
      </div>
      {expanded && item.panel && !isColumnPanel(item.panel) && (
        <div className="space-y-3 border-t p-3">
          <section className="space-y-3 rounded-md border p-3">
            <h4 className="text-sm font-medium">{tPanel("panelBlocks")}</h4>
            {item.panel.blocks.map((block, index) => (
              <LocalizedBlockEditor
                key={block.id}
                block={block}
                locale={locale}
                savedAltAuthored={authoredAltIds.includes(block.id)}
                placeholder={
                  placeholder?.panel && !isColumnPanel(placeholder.panel)
                    ? placeholder.panel.blocks[index]
                    : undefined
                }
                onChange={(updated) =>
                  onChange({
                    ...item,
                    panel: {
                      ...(item.panel! as Extract<
                        NonNullable<LocaleNavItem["panel"]>,
                        { columns: number }
                      >),
                      blocks: (isColumnPanel(item.panel!)
                        ? []
                        : item.panel!.blocks
                      ).map((current) =>
                        current.id === block.id ? updated : current
                      ),
                    },
                  })
                }
              />
            ))}
          </section>
          <section className="space-y-3 rounded-md border p-3">
            <h4 className="text-sm font-medium">{tPanel("footerBlocks")}</h4>
            {item.panel.footer?.blocks.map((block, index) => (
              <LocalizedBlockEditor
                key={block.id}
                block={block}
                locale={locale}
                savedAltAuthored={authoredAltIds.includes(block.id)}
                placeholder={placeholder?.panel?.footer?.blocks[index]}
                onChange={(updated) =>
                  onChange({
                    ...item,
                    panel: {
                      ...item.panel!,
                      footer: {
                        blocks: item.panel!.footer!.blocks.map((current) =>
                          current.id === block.id ? updated : current
                        ),
                      },
                    },
                  })
                }
              />
            ))}
          </section>
        </div>
      )}
    </div>
  )
}

function LocalizedBlockEditor({
  block,
  locale,
  savedAltAuthored,
  placeholder,
  onChange,
}: {
  block: LocaleBlock
  locale: string
  savedAltAuthored: boolean
  placeholder: LocaleBlock | undefined
  onChange: (block: LocaleBlock) => void
}) {
  const t = useTranslations("menus.items")
  const [altAuthored, setAltAuthored] = useState(false)
  const fieldId = useId()

  if (block.kind === "linkGroup") {
    const placeholderGroup =
      placeholder?.kind === "linkGroup" ? placeholder : undefined
    return (
      <div className="space-y-3 rounded-md border bg-background p-3">
        <LocalizedInput
          locale={locale}
          id={`${fieldId}-heading`}
          label={t("heading")}
          value={block.heading ?? ""}
          placeholder={placeholderGroup?.heading}
          onChange={(heading) =>
            onChange({ ...block, heading: heading || undefined })
          }
        />
        {block.links.map((link, index) => {
          const placeholderLink = placeholderGroup?.links[index]
          return (
            <div key={link.id} className="space-y-3 rounded-md border p-3">
              <LocalizedInput
                locale={locale}
                id={`${fieldId}-link-${link.id}-label`}
                label={t("buttonLabel")}
                emptyKind="link"
                value={link.label}
                placeholder={placeholderLink?.label}
                onChange={(label) =>
                  onChange({
                    ...block,
                    links: block.links.map((current) =>
                      current.id === link.id ? { ...current, label } : current
                    ),
                  })
                }
              />
              <LocalizedTextarea
                id={`${fieldId}-link-${link.id}-description`}
                label={t("description")}
                value={link.description ?? ""}
                placeholder={placeholderLink?.description}
                onChange={(description) =>
                  onChange({
                    ...block,
                    links: block.links.map((current) =>
                      current.id === link.id
                        ? { ...current, description: description || undefined }
                        : current
                    ),
                  })
                }
              />
            </div>
          )
        })}
      </div>
    )
  }

  if (block.kind === "dynamicList") {
    const placeholderList =
      placeholder?.kind === "dynamicList" ? placeholder : undefined
    return (
      <div className="space-y-3 rounded-md border bg-background p-3">
        <LocalizedInput
          locale={locale}
          id={`${fieldId}-heading`}
          label={t("heading")}
          value={block.heading ?? ""}
          placeholder={placeholderList?.heading}
          onChange={(heading) =>
            onChange({ ...block, heading: heading || undefined })
          }
        />
        {block.seeAll && (
          <LocalizedInput
            locale={locale}
            id={`${fieldId}-see-all`}
            label={t("seeAllLabel")}
            emptyKind="seeAll"
            value={block.seeAll.label}
            placeholder={placeholderList?.seeAll?.label}
            onChange={(label) =>
              onChange({
                ...block,
                seeAll: { ...block.seeAll!, label },
              })
            }
          />
        )}
      </div>
    )
  }

  const placeholderFeatured =
    placeholder?.kind === "featured" ? placeholder : undefined
  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      <LocalizedInput
        locale={locale}
        id={`${fieldId}-heading`}
        label={t("heading")}
        value={block.heading}
        emptyKind="block"
        placeholder={placeholderFeatured?.heading}
        onChange={(heading) => onChange({ ...block, heading })}
      />
      <LocalizedTextarea
        id={`${fieldId}-description`}
        label={t("description")}
        value={block.description ?? ""}
        placeholder={placeholderFeatured?.description}
        onChange={(description) =>
          onChange({ ...block, description: description || undefined })
        }
      />
      <LocalizedInput
        locale={locale}
        id={`${fieldId}-alt`}
        label={t("imageAlt")}
        value={block.image?.alt ?? ""}
        emptyKind={savedAltAuthored || altAuthored ? null : "block"}
        placeholder={placeholderFeatured?.image?.alt}
        onChange={(alt) => {
          setAltAuthored(true)
          onChange(withAuthoredAlt(block, alt))
        }}
      />
    </div>
  )
}

function LocalizedInput({
  id,
  locale,
  emptyKind = "heading",
  label,
  value,
  placeholder,
  onChange,
}: {
  id: string
  locale: string
  emptyKind?: "heading" | "item" | "link" | "block" | "seeAll" | null
  label: string
  value: string
  placeholder?: string
  onChange: (value: string) => void
}) {
  const tEmpty = useTranslations("menus.emptyText")
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <Input
          className="pr-8"
          id={id}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
        {emptyKind && !value.trim() && (
          <EmptyLocaleIcon
            message={tEmpty(emptyKind, { locale: locale.toUpperCase() })}
          />
        )}
      </div>
    </div>
  )
}

function LocalizedTextarea({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  id: string
  label: string
  value: string
  placeholder?: string
  onChange: (value: string) => void
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Textarea
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        rows={2}
      />
    </div>
  )
}

function StateMessage({
  heading,
  message,
}: {
  heading: React.ReactNode
  message: string
}) {
  return (
    <div className="max-w-3xl space-y-6">
      {heading}
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  )
}

function ReadOnlyMenuTree({ nav }: { nav: LocaleNavItem[] }) {
  const t = useTranslations("menus.editor")
  if (nav.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {t("emptyReadOnly")}
      </p>
    )
  }
  return (
    <ul className="space-y-4">
      {nav.map((item) => (
        <li key={item.id} className="rounded-lg border p-4">
          <p className="font-medium">{item.label}</p>
          {item.panel && (
            <ul className="mt-3 space-y-3 border-l pl-4">
              {panelBlocks(item.panel)
                .map((entry) => entry.block)
                .map((block) => (
                  <li key={block.id}>
                    <p className="text-sm font-medium">
                      {block.kind === "featured"
                        ? block.heading
                        : (block.heading ?? t("untitledItem"))}
                    </p>
                    {block.kind === "linkGroup" && (
                      <ul className="space-y-1 text-sm text-muted-foreground">
                        {block.links.map((link) => (
                          <li key={link.id}>{link.label}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  )
}
