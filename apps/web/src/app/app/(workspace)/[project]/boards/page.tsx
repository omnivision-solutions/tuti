import { permanentRedirect } from "next/navigation";

/** Boards are in Feedback now (its header's Boards button). */
export default async function BoardsPage(props: PageProps<"/app/[project]/boards">) {
  permanentRedirect(`/app/${(await props.params).project}/feedback/boards`);
}
