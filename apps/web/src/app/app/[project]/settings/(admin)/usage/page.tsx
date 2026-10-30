import { permanentRedirect } from "next/navigation";

/** Usage is on Settings → Billing now, under the plan and credits. */
export default async function UsagePage(props: PageProps<"/app/[project]/settings/usage">) {
  permanentRedirect(`/app/${(await props.params).project}/settings/billing#usage`);
}
