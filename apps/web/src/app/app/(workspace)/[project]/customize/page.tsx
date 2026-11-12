import { permanentRedirect } from "next/navigation";

/** Customize is Settings' Portal pages now: its first. */
export default async function CustomizePage(props: PageProps<"/app/[project]/customize">) {
  permanentRedirect(`/app/${(await props.params).project}/settings/branding`);
}
