"use client";

import { getPublicMessages } from "@/lib/i18n/public-messages";
import { usePresentationLocale } from "@/components/public/presentation-locale";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, UserCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

type SessionLabel = { name: string | null } | null;

// Public pages are static, so they never read the auth cookie on the server.
// The browser asks this private route for the signed-in label instead
// (ADR-0056 rule 8: the display name only, never the username).
const SESSION_LABEL_ROUTE = "/api/session-label";
const SIGN_OUT_ROUTE = "/auth/signout";

async function readSessionLabel(): Promise<SessionLabel> {
  try {
    const response = await fetch(SESSION_LABEL_ROUTE, { cache: "no-store" });
    return response.ok ? ((await response.json()) as SessionLabel) : null;
  } catch {
    return null;
  }
}

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
  // `undefined` while the label loads; `null` when signed out.
  const [user, setUser] = useState<SessionLabel | undefined>(undefined);
  const isMobile = variant === "mobile";

  useEffect(() => {
    let active = true;
    void readSessionLabel().then((label) => {
      if (active) setUser(label);
    });
    return () => {
      active = false;
    };
  }, []);

  function handleSignOut() {
    setSigningOut(true);
    // The Convex Auth sign-out route ends the session and clears its cookies.
    void fetch(SIGN_OUT_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
      .then(() => {
        setUser(null);
        onNavigate?.();
        router.refresh();
      })
      .catch(() => {})
      .finally(() => {
        setSigningOut(false);
      });
  }

  if (user === undefined) {
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

  const displayName = user.name?.trim() || messages.loggedIn;

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
