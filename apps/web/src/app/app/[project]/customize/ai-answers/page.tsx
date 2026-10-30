import { permanentRedirect } from "next/navigation";

/** Moved to Settings: how the AI answers is in AI → AI answers, where questions go in Support → Ask a person. */
export default async function Moved(props: PageProps<"/app/[project]/customize/ai-answers">) {
  permanentRedirect(`/app/${(await props.params).project}/settings/ai-answers`);
}
