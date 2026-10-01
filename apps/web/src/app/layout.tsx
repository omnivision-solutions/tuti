import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";

import { SignOutButton } from "@/components/sign-out-button";
import { getSession } from "@/server/session";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Tuti",
  description: "Open-source feature voting & product feedback",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const session = await getSession();

  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">
        <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-3 dark:border-zinc-800">
          <Link href="/" className="font-semibold">
            Tuti
          </Link>
          {session ? (
            <div className="flex items-center gap-4 text-sm">
              <span className="text-zinc-500">{session.user.email}</span>
              <SignOutButton />
            </div>
          ) : (
            <Link href="/sign-in" className="text-sm">
              Sign in
            </Link>
          )}
        </header>
        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-10">{children}</main>
      </body>
    </html>
  );
}
