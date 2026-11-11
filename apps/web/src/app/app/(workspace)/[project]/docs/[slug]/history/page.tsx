import { redirect } from "next/navigation";

/** An article's history is a panel on its page now (`?history`): links to this address go there. */
export default async function ArticleHistoryPage(props: PageProps<"/app/[project]/docs/[slug]/history">) {
  const [{ project: slug, slug: articleSlug }, { revision }] = await Promise.all([props.params, props.searchParams]);
  redirect(`/app/${slug}/docs/${articleSlug}?history${typeof revision === "string" ? `&revision=${encodeURIComponent(revision)}` : ""}`);
}
