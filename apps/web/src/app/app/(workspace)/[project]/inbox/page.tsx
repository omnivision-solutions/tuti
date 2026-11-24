import type { Metadata } from "next";
import { inboxPages, InboxPanes, inboxQuery, inboxView } from "@/components/inbox/inbox-panes";

export const metadata: Metadata = { title: "Inbox" };

/** The inbox in a view (`?view=`) or a search's results (`?q=`), with no conversation open yet: the Inbox's numbers beside the list. */
export default async function InboxPage(props: PageProps<"/app/[project]/inbox">) {
  const { project: slug } = await props.params;
  const { view, page, q } = await props.searchParams;
  return <InboxPanes slug={slug} view={inboxView(view)} open={null} pages={inboxPages(page)} q={inboxQuery(q)} />;
}
