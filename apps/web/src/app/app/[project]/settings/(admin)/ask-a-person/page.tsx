import { permanentRedirect } from "next/navigation";

/** "Ask a person" starts a conversation in the inbox, so it's on with Messages in the widget (Settings → Inbox and email). */
export default async function Moved(props: PageProps<"/app/[project]/settings/ask-a-person">) {
  permanentRedirect(`/app/${(await props.params).project}/settings/support`);
}
