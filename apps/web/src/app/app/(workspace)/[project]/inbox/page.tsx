import { inboxPages, InboxPanes, inboxView } from "@/components/inbox/inbox-panes";

/** The inbox in a view (`?view=`), with no conversation open yet: the Inbox's numbers beside the list. */
export default async function InboxPage(props: PageProps<"/app/[project]/inbox">) {
  const { project: slug } = await props.params;
  const { view, page } = await props.searchParams;
  return <InboxPanes slug={slug} view={inboxView(view)} open={null} pages={inboxPages(page)} />;
}
