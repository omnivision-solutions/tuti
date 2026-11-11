import { permanentRedirect } from "next/navigation";

/** In Customize → Navigation now. */
export default async function Moved(props: PageProps<"/app/[project]/customize/home-page">) {
  permanentRedirect(`/app/${(await props.params).project}/customize/navigation`);
}
