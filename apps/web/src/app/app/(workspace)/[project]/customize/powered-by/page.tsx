import { permanentRedirect } from "next/navigation";

/** In Settings → Branding now. */
export default async function Moved(props: PageProps<"/app/[project]/customize/powered-by">) {
  permanentRedirect(`/app/${(await props.params).project}/settings/branding#powered-by`);
}
