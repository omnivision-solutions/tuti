import type { Metadata } from "next";

import { getSession } from "@/server/session";

import { Landing } from "./landing";
import { docsUrl, REPO_URL } from "./links";

export const metadata: Metadata = {
  title: "Tuti: the help center that keeps up with what you ship",
  description:
    "Tuti is a knowledge base with feature requests and a changelog built in, kept current from what you merge: stale articles fixed, new ones written, shipped feature requests closed and the changelog drafted.",
};

export default async function Home() {
  // Signed in, "Start free" is "Open app", to the app rather than sign-up.
  const start = (await getSession()) ? "/app" : "/sign-up";
  const docs = await docsUrl();
  // Tuti's own help center, on Tuti, where the server has one (else the docs in the repository).
  return <Landing start={start} docs={docs} dogfood={!docs.startsWith(REPO_URL)} />;
}
