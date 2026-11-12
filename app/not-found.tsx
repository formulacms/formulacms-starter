// Root-level not-found: displayed when Next.js cannot match any route segment
// and there is no closer not-found boundary. This page lives outside the public
// and core route-group layouts, so it must own its HTML shell and imports
// globals.css directly to load fonts and design tokens.

import Link from "next/link";
import { HydrationExtensionAttributeCleanup } from "@/components/hydration-extension-attribute-cleanup";
import "./globals.css";

export default function RootNotFound() {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        suppressHydrationWarning
        className="min-h-screen bg-background text-foreground antialiased"
      >
        <HydrationExtensionAttributeCleanup />
        <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
          <span className="text-sm text-muted-foreground uppercase tracking-widest">
            404
          </span>

          <h1 className="text-3xl font-semibold tracking-tight">
            Page not found
          </h1>

          <p className="text-muted-foreground max-w-sm">
            The page you&apos;re looking for doesn&apos;t exist or has been
            moved.
          </p>

          <Link
            href="/"
            className="mt-2 inline-flex items-center justify-center rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            Return home
          </Link>
        </main>
      </body>
    </html>
  );
}
