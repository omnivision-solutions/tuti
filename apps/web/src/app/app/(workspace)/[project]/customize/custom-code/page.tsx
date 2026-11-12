import { permanentRedirect } from "next/navigation";

/** Moved to Settings → Portal. */
export default async function Moved(props: PageProps<"/app/[project]/customize/custom-code">) {
  permanentRedirect(`/app/${(await props.params).project}/settings/custom-code`);
}
