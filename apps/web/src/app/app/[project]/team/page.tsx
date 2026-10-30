import { permanentRedirect } from "next/navigation";

/** Team moved into Settings, as Team & roles. */
export default async function TeamPage(props: PageProps<"/app/[project]/team">) {
  permanentRedirect(`/app/${(await props.params).project}/settings/team`);
}
