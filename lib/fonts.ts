import { Geist_Mono, Inter } from "next/font/google"

// Shared font loaders for both root layouts ((public) + (core)). Declaring them
// once here avoids invoking the next/font loaders twice and keeps the two
// document shells in lockstep.
export const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "optional",
  weight: "variable",
  style: "normal",
})

export const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "optional",
  weight: "variable",
  style: "normal",
})

// Class string applied to <html> in every root layout.
export const fontClassName = `antialiased ${fontMono.variable} ${inter.className} ${inter.variable}`
