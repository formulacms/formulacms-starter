import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { getTranslations } from "next-intl/server"
import {
  SetupWizard,
  type SetupWizardMessages,
} from "@/components/setup/setup-wizard"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card"
import { getSiteConfigState } from "@/lib/i18n/site-config"
import { readSetupBootstrapHandoff } from "@/lib/setup/bootstrap-handoff"
import { resolveOwnerCodeTarget } from "@/lib/setup/owner-code-command"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"

// Only the two namespaces the wizard uses (`caughtErrors` backs its error
// text) reach the client for each admin dictionary; the wizard re-renders in
// the language chosen on its first step when one of these exists.
const SETUP_WIZARD_MESSAGES: SetupWizardMessages = {
  en: { setup: en.setup, caughtErrors: en.caughtErrors },
  fr: { setup: fr.setup, caughtErrors: fr.caughtErrors },
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("setup.metadata")
  return { title: t("title"), robots: { index: false } }
}

export const dynamic = "force-dynamic"

type SetupPageProps = {
  searchParams: Promise<{ "recover-owner"?: string | string[] }>
}

export default async function SetupPage({ searchParams }: SetupPageProps) {
  const recoverOwner = (await searchParams)?.["recover-owner"] === "1"
  const [siteConfigState, initialSetup] = await Promise.all([
    getSiteConfigState(),
    readSetupBootstrapHandoff(),
  ])

  if (siteConfigState.status === "unavailable") {
    const t = await getTranslations("setup.statusUnavailable")
    return (
      <main className="grid min-h-svh place-items-center p-6">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <h1 className="font-heading text-xl leading-tight font-medium text-balance">
              {t("title")}
            </h1>
            <CardDescription>{t("description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <p className="text-sm leading-relaxed">{t("unchanged")}</p>
            <form action="/setup" method="get">
              <Button type="submit">{t("retry")}</Button>
            </form>
            <details className="text-sm text-muted-foreground">
              <summary className="cursor-pointer">{t("operator")}</summary>
              <p className="mt-2 leading-relaxed">
                {t.rich("operatorHint", {
                  variable: (chunks) => <code>{chunks}</code>,
                })}
              </p>
            </details>
          </CardContent>
        </Card>
      </main>
    )
  }

  // A completed site normally leaves setup permanently. The owner-recovery
  // path is intentionally claim-gated inside SetupWizard so a rotated claim
  // can repair a stale owner binding without reopening ordinary onboarding.
  if (siteConfigState.value.onboardingCompletedAt != null && !recoverOwner) {
    redirect("/admin")
  }

  return (
    <main className="grid min-h-svh place-items-center p-6">
      <SetupWizard
        initialSetup={initialSetup}
        messages={SETUP_WIZARD_MESSAGES}
        ownerCodeTarget={resolveOwnerCodeTarget(process.env, process.cwd())}
      />
    </main>
  )
}
