"use client"

import { ConvexError } from "convex/values"
import { useLocale, useTranslations } from "next-intl"
import type { FunctionReturnType } from "convex/server"
import type { api } from "@/convex/_generated/api"
import type {
  PageAddressCheck,
  PageAddressNotice,
} from "@/convex/lib/publishing/snapshots"
import {
  adminContentTypeLabel,
  adminContentTypeSingularMessageKey,
} from "./content-types"

type AddressCopyKey =
  keyof (typeof import("@/messages/admin/en.json"))["pageAddress"]
export type AddressAvailability = FunctionReturnType<
  typeof api.cms.publication.addressAvailability
>
export type AddressEntry = AddressAvailability["entries"][number]
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null
}
export function addressErrorData(
  error: unknown
): Record<string, unknown> | null {
  return record(error instanceof ConvexError ? error.data : error)
}
export function addressSaveRefusal(error: unknown): "S1f" | "S3t" | null {
  const data = addressErrorData(error)
  if (
    !data ||
    ![
      "PAGE_PARENT_ADDRESS_TAKEN",
      "PAGE_ADDRESS_TAKEN",
      "PAGE_ADDRESS_ARCHIVED",
      "PAGE_ADDRESS_HISTORICAL",
      "PAGE_ADDRESS_SYSTEM_RESERVED",
      "LANGUAGE_LOCALE_PREFIX_RESERVED",
    ].includes(String(data.code))
  )
    return null
  return data.source === "parent"
    ? "S3t"
    : data.source === "identifier"
      ? "S1f"
      : null
}

export function createPageAddressMessages(
  t: (key: AddressCopyKey, values?: Record<string, string>) => string,
  admin: string,
  defaultLocale: string,
  typeLabel: (type: string) => string
) {
  const displayPath = (locale: string, path: string) =>
    locale === defaultLocale ? path : `/${locale}${path === "/" ? "" : path}`
  function language(locale: string) {
    const name =
      new Intl.DisplayNames([admin], { type: "language" }).of(locale) ?? locale
    const adjectives: Record<string, string> = {
      en: "anglaise",
      fr: "française",
      es: "espagnole",
      it: "italienne",
      pt: "portugaise",
      "pt-br": "portugaise du Brésil",
      nl: "néerlandaise",
      sv: "suédoise",
      pl: "polonaise",
      ru: "russe",
      tr: "turque",
      hi: "hindie",
      zh: "chinoise",
      ja: "japonaise",
      ko: "coréenne",
    }
    return {
      languageName:
        admin === "en" ? name.charAt(0).toUpperCase() + name.slice(1) : name,
      languageNameLower: name,
      languageAdjective: adjectives[locale] ?? name,
    }
  }
  function copy(
    id: AddressCopyKey,
    values: Record<string, string>,
    check?: PageAddressCheck,
    pageType?: string
  ) {
    let message = t(id, values)
    const holder = check?.holder
    if (holder && pageType && holder.pageType !== pageType) {
      const quoted =
        admin === "fr" ? `« ${holder.title} »` : `“${holder.title}”`
      // In every approved message the holder is the final quoted title.
      // Earlier titles can be identical (parent, child or restored page).
      const end = message.lastIndexOf(quoted) + quoted.length
      if (end >= quoted.length)
        message = `${message.slice(0, end)} (${typeLabel(holder.pageType)})${message.slice(end)}`
    }
    return message
  }
  function vars(check: PageAddressCheck) {
    return {
      path: check.path ? displayPath(check.locale, check.path) : "",
      title: check.holder?.title ?? "",
      ...language(check.reservedLocale ?? check.locale),
    }
  }
  function field(check: PageAddressCheck, pageType: string) {
    if (check.kind === "free" || !check.path) return null
    if (check.kind === "historical" && !check.canRedirect)
      return check.holder ? copy("S1g", vars(check), check, pageType) : null
    const key = (
      {
        taken: "S1a",
        archived: "S1b",
        historical: "S1c",
        system: "S1d",
        language: "S1e",
      } as const
    )[check.kind]
    return copy(key, vars(check), check, pageType)
  }
  function parent(
    entry: AddressEntry,
    selectedLocale: string,
    pageType: string
  ) {
    const check = entry.check
    if (check.kind === "free") return null
    if (!entry.parentTitle) {
      if (check.kind === "system" || check.kind === "language")
        return copy(check.kind === "system" ? "S3rd" : "S3re", vars(check))
      if (!check.holder) return null
      return copy(
        entry.locale === selectedLocale ? "S3r" : "S3or",
        { ...vars(check), ...language(entry.locale) },
        check,
        pageType
      )
    }
    // Reserved paths occupy the first segment, so they cannot occur under a parent.
    if (!check.holder) return null
    return copy(
      entry.locale === selectedLocale ? "S3" : "S3o",
      { ...vars(check), ...language(entry.locale), parent: entry.parentTitle },
      check,
      pageType
    )
  }
  function allocation(
    entry: AddressEntry | undefined,
    kind: "S2a" | "S2b",
    fallback: string | null,
    pageType: string
  ) {
    const allocated = entry?.allocation
    if (
      !allocated ||
      allocated.check.kind === "free" ||
      !allocated.check.path ||
      !allocated.newPath
    )
      return fallback
    if (!allocated.check.holder) {
      if (
        allocated.check.kind !== "system" &&
        allocated.check.kind !== "language"
      )
        return fallback
      return copy(`${kind}-${allocated.check.kind === "system" ? "d" : "e"}`, {
        ...language(allocated.check.reservedLocale ?? entry.locale),
        wantedPath: displayPath(entry.locale, allocated.check.path),
        newPath: displayPath(entry.locale, allocated.newPath),
      })
    }
    return copy(
      kind,
      {
        wantedPath: displayPath(entry.locale, allocated.check.path),
        newPath: displayPath(entry.locale, allocated.newPath),
        title: allocated.check.holder.title,
      },
      allocated.check,
      pageType
    )
  }
  function restored(
    notices: PageAddressNotice[] | undefined,
    kind: "S4",
    fallback: string,
    pageTitle: string,
    pageType: string
  ): string
  function restored(
    notices: PageAddressNotice[] | undefined,
    kind: "S5",
    fallback: string,
    pageTitle: string,
    pageType: string,
    localizedTitles?: Record<string, string>
  ): string[]
  function restored(
    notices: PageAddressNotice[] | undefined,
    kind: "S4" | "S5",
    fallback: string,
    pageTitle: string,
    pageType: string,
    localizedTitles?: Record<string, string>
  ): string | string[] {
    function message(notice: PageAddressNotice) {
      if (!notice.check.holder) return fallback
      return copy(
        kind === "S5" && notice.kept === "published"
          ? "S5k"
          : kind === "S5" && notice.kept === "archived"
            ? "S5a"
            : kind,
        {
          ...language(notice.locale),
          oldPath: displayPath(notice.locale, notice.oldPath),
          currentPath: displayPath(notice.locale, notice.newPath),
          newPath: displayPath(notice.locale, notice.newPath),
          title:
            kind === "S4"
              ? notice.check.holder.title
              : localizedTitles?.[notice.locale] || pageTitle,
          holder: notice.check.holder.title,
        },
        notice.check,
        pageType
      )
    }
    if (kind === "S4") return notices?.[0] ? message(notices[0]) : fallback
    if (!notices?.length) return [fallback]
    return [...notices]
      .sort(
        (a, b) =>
          Number(b.locale === defaultLocale) -
          Number(a.locale === defaultLocale)
      )
      .map(message)
      .filter((message, index, messages) => messages.indexOf(message) === index)
  }
  function publish(
    error: unknown,
    fallback: string,
    pageType?: string,
    editor = false
  ) {
    const data = addressErrorData(error)
    if (!data || data.source !== "publish") return fallback
    if (data.code === "PUBLISHED_CHILD_ROUTE_TAKEN") {
      const check = record(data.check) as PageAddressCheck | null
      if (!editor || !check?.holder || !check.path) return fallback
      return copy(
        "S6e",
        {
          parent: String(data.parentTitle),
          path: displayPath(String(data.locale), String(data.path)),
          child: String(data.childTitle),
          childPath: displayPath(String(data.locale), check.path),
          holder: check.holder.title,
        },
        check,
        pageType
      )
    }
    const check = data as unknown as PageAddressCheck
    if (
      !check.path ||
      !["taken", "archived", "historical", "system", "language"].includes(
        check.kind
      )
    )
      return fallback
    if (
      (check.kind === "taken" ||
        check.kind === "archived" ||
        check.kind === "historical") &&
      !check.holder
    )
      return fallback
    const key = (
      {
        taken: "S6a",
        archived: "S6a",
        historical: check.canRedirect ? "S6b" : "S6g",
        language: "S6c",
        system: "S6d",
        free: "S6a",
      } as const
    )[check.kind]
    return copy(key, vars(check), check, pageType)
  }
  return {
    field,
    parent,
    allocation,
    restored,
    publish,
    save: (error: unknown, fallback: string) => {
      const key = addressSaveRefusal(error)
      return key ? t(key) : fallback
    },
    refusal: (parentChanged: boolean) => t(parentChanged ? "S3t" : "S1f"),
  }
}
export function usePageAddressMessages(defaultLocale: string) {
  const t = useTranslations("pageAddress")
  const types = useTranslations("sidebar.contentType")
  const locale = useLocale()
  return createPageAddressMessages(t, locale, defaultLocale, (type) => {
    const key = adminContentTypeSingularMessageKey(type)
    return key && types.has(key)
      ? types(key)
      : adminContentTypeLabel(
          type as Parameters<typeof adminContentTypeLabel>[0]
        ).singular
  })
}
