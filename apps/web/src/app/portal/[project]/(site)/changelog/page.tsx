import { changelogMetadata, changelogPage } from "@/components/changelog-pages";

export async function generateMetadata(props: PageProps<"/portal/[project]/changelog">) {
  return changelogMetadata((await props.params).project);
}

/** The changelog's newest entries; older ones are at /changelog/page/2 and on. */
export default async function ChangelogPage(props: PageProps<"/portal/[project]/changelog">) {
  return changelogPage((await props.params).project, 1);
}
