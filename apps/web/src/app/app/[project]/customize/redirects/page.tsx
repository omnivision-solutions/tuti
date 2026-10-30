import { permanentRedirect } from "next/navigation";

/** Moved to Settings → Domain. */
export default async function Moved(props: PageProps<"/app/[project]/customize/redirects">) {
  permanentRedirect(`/app/${(await props.params).project}/settings/domain`);
}
