import type { Metadata } from "next"

// The auth pages are client components, so the document title (required by
// the admin axe/CWV baseline — document-title) is provided here. Neutral
// wording: this layout covers sign-in/up and password reset.
export const metadata: Metadata = {
  title: "formulacms admin",
}

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
