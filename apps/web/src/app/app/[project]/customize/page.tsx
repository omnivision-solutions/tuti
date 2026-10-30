import { redirect } from "next/navigation";

/** Customize opens on its first section: the others are in its rail. */
export default async function CustomizePage(props: PageProps<"/app/[project]/customize">) {
  redirect(`/app/${(await props.params).project}/customize/branding`);
}
