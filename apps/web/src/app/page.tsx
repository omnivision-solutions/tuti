import { redirect } from "next/navigation";

/**
 * The app's own home: the app. On Tuti's cloud the domain sends `/` to the marketing site (apps/marketing) instead; a
 * self-hosted server has none.
 */
export default function Home() {
  redirect("/app");
}
