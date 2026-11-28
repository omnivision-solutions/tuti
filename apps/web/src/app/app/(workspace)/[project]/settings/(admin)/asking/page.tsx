import type { Metadata } from "next";

import { AskingPropertySelect } from "@/components/asking-property-select";
import { SettingsCard, SettingsPane } from "@/components/settings-card";
import { serverCaller } from "@/server/trpc/server";

export const metadata: Metadata = { title: "Who's asking · Settings" };

/** Settings → Users → Who's asking: the property Feedback totals over each post's voters (was in Access). */
export default async function AskingSettingsPage(props: PageProps<"/app/[project]/settings/asking">) {
  const { project: slug } = await props.params;
  // Owners and admins only (settings.asking's access): anyone else gets a 404.
  const { property, properties, formats } = await (await serverCaller()).settings.asking({ project: slug });
  return (
    <SettingsPane title="Who's asking">
      <SettingsCard>
        <AskingPropertySelect projectSlug={slug} property={property} properties={properties} formats={formats} />
      </SettingsCard>
    </SettingsPane>
  );
}
