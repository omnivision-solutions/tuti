import { permanentRedirect } from "next/navigation";

/** Moved to Settings → Portal. */
export default async function Moved(props: PageProps<"/app/[project]/customize/branding">) {
  permanentRedirect(`/app/${(await props.params).project}/settings/branding`);
}
