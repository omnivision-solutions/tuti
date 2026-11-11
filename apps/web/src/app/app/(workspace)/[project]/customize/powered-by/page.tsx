import { permanentRedirect } from "next/navigation";

/** In Customize → Branding now. */
export default async function Moved(props: PageProps<"/app/[project]/customize/powered-by">) {
  permanentRedirect(`/app/${(await props.params).project}/customize/branding#powered-by`);
}
