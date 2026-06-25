import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_URL = "https://www.getgrantify.com";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Grantify — AI-assisted grant management for nonprofits",
    template: "%s · Grantify",
  },
  description:
    "Grantify helps nonprofits discover, track, and write grants — AI-generated application forms, knowledge-base auto-fill, and narrative drafting, from discovery to submission.",
  applicationName: "Grantify",
  keywords: [
    "grant management software",
    "nonprofit grants",
    "grant writing AI",
    "grant discovery",
    "grant application software",
    "Grants.gov search",
    "nonprofit fundraising",
    "grant tracker",
  ],
  authors: [{ name: "Grantify" }],
  creator: "Grantify",
  category: "business",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "Grantify",
    title: "Grantify — AI-assisted grant management for nonprofits",
    description:
      "Discover, track, and write grants with AI. From discovery to submission for nonprofits.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Grantify — AI-assisted grant management for nonprofits",
    description:
      "Discover, track, and write grants with AI. From discovery to submission for nonprofits.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
