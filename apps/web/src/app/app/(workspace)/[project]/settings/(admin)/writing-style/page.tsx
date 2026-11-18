import { permanentRedirect } from "next/navigation";

/** Moved to Settings → Changelog. */
export default async function Moved(props: PageProps<"/app/[project]/settings/writing-style">) {
  permanentRedirect(`/app/${(await props.params).project}/settings/changelog`);
}
