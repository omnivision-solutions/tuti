import type { Metadata } from "next";

import { appUrl } from "@/lib/hosts";

const description = "The help center that stays in sync with your code: docs, AI answers, an inbox, feedback, a roadmap and a changelog.";

/**
 * Every /app page's tags (not the root layout's: portals are the teams' own sites, with their own names). Never indexed:
 * the pages are private, and the sign-in pages are no answer to a search. Shared, a link shows Tuti's card
 * (auth/card.png: unfurlers aren't signed in).
 */
export function generateMetadata(): Metadata {
  return {
    // Per request: the server's own address (APP_URL), which a build doesn't have.
    metadataBase: appUrl(),
    title: { template: "%s · Tuti", default: "Tuti" },
    description,
    applicationName: "Tuti",
    robots: { index: false, follow: false },
    openGraph: { siteName: "Tuti", title: "Tuti", description, type: "website", images: [{ url: "/app/auth/card.png", width: 1200, height: 630, alt: "Tuti: the help center that stays in sync with your code" }] },
    twitter: { card: "summary_large_image", title: "Tuti", description, images: ["/app/auth/card.png"] },
  };
}

export default function AppPagesLayout({ children }: LayoutProps<"/app">) {
  return children;
}
