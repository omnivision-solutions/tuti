import { ConversationPane, InboxPanes, inboxView } from "@/components/inbox/inbox-panes";

/** The inbox in a view (`?view=`), with no conversation open yet. */
export default async function InboxPage(props: PageProps<"/app/[project]/inbox">) {
  const { project: slug } = await props.params;
  const { view } = await props.searchParams;
  return (
    <InboxPanes slug={slug} view={inboxView(view)} open={null}>
      <ConversationPane open={false}>
        <p className="text-sm text-muted-foreground">Open a conversation to reply here: click it, or press J.</p>
      </ConversationPane>
    </InboxPanes>
  );
}
