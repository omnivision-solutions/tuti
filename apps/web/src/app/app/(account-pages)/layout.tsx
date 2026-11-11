import Link from "next/link";

import { TutiLogo } from "@/components/tuti-logo";

// Rendered for each request, never at build time: their pages read the server's settings (email, licences), which a build doesn't have.
export const dynamic = "force-dynamic";

/** The app's pages for the signed out (sign-in, sign-up, invites, …) and the operator's links: Tuti's logo over a centred page. */
export default function AccountPagesLayout({ children }: LayoutProps<"/app">) {
  return (
    <>
      <header className="mx-auto flex h-16 w-full max-w-[1240px] items-center px-5 md:px-8">
        <Link href="/" aria-label="Tuti home">
          <TutiLogo />
        </Link>
      </header>
      {/* Centred down the window: a short page (sign-in, forgot password) sits in the middle, not under the header. */}
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-6 py-10 has-data-wide:max-w-5xl has-data-full:max-w-none has-data-full:p-0">{children}</main>
    </>
  );
}
