"use client";

import { getPublicMessages } from "@/lib/i18n/public-messages";
import { usePresentationLocale } from "@/components/public/presentation-locale";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, UserCircle } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

interface HeaderAuthControlsProps {
  variant?: "desktop" | "mobile";
  onNavigate?: () => void;
}

export function HeaderAuthControls({
  variant = "desktop",
  onNavigate,
}: HeaderAuthControlsProps) {
  const { locale } = usePresentationLocale();
  const messages = getPublicMessages(locale).chrome;
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);
  const { data: session, isPending } = authClient.useSession();
  const user = session?.user;
  const isMobile = variant === "mobile";

  function handleSignOut() {
    setSigningOut(true);
    void authClient
      .signOut()
      .then(() => {
        onNavigate?.();
        router.refresh();
      })
      .finally(() => {
        setSigningOut(false);
      });
  }

  if (isPending) {
    return (
      <output
        aria-label={messages.checkingSession}
        className={
          isMobile
            ? "block h-9 w-full rounded-md bg-surface-2"
            : "block h-8 w-24 rounded-md bg-surface-2"
        }
      />
    );
  }

  if (!user) {
    return (
      <Button
        asChild
        size={isMobile ? "default" : "sm"}
        variant="outline"
        className={isMobile ? "w-full" : undefined}
      >
        <Link href="/sign-in" onClick={onNavigate}>
          {messages.signIn}
        </Link>
      </Button>
    );
  }

  const displayName = user.name?.trim() || user.email?.trim() || messages.loggedIn;

  if (isMobile) {
    return (
      <div className="flex flex-col gap-stack">
        <div className="rounded-md border border-border bg-surface-2 px-stack py-stack">
          <p className="text-caption text-on-surface-muted">{messages.signedInAs}</p>
          <p className="truncate text-sm font-medium text-on-surface">
            {displayName}
          </p>
        </div>
        <Button asChild variant="outline" className="w-full justify-start">
          <Link href="/admin" onClick={onNavigate}>
            <UserCircle className="size-4" />
            {messages.admin}
          </Link>
        </Button>
        <Button
          type="button"
          variant="destructive"
          className="w-full justify-start"
          onClick={handleSignOut}
          disabled={signingOut}
        >
          <LogOut className="size-4" />
          {signingOut ? messages.signingOut : messages.logOut}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button asChild size="sm" variant="ghost" className="max-w-44 px-2">
        <Link href="/admin" title={displayName}>
          <UserCircle className="size-4" />
          <span className="truncate">{displayName}</span>
        </Link>
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="outline"
        aria-label={messages.logOut}
        onClick={handleSignOut}
        disabled={signingOut}
      >
        <LogOut className="size-4" />
      </Button>
    </div>
  );
}
