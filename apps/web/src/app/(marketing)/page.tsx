import type { Metadata } from "next";

import { getSession } from "@/server/session";

import { Landing } from "./landing";
import { docsUrl, REPO_URL } from "./links";

export const metadata: Metadata = {
  title: "Tuti: the help center that stays in sync with your code",
  description:
    "Tuti is a knowledge base with AI answers, an inbox, a feedback board, a roadmap and a changelog, kept in sync with the code you ship.",
};

export default async function Home() {
  // Signed in, "Start free" is "Open app", to the app rather than sign-up.
  const start = (await getSession()) ? "/app" : "/sign-up";
  const docs = await docsUrl();
  // "See a live help center": Tuti's own, on Tuti, where the server has one.
  return <Landing start={start} docs={docs.startsWith(REPO_URL) ? null : docs} />;
}
