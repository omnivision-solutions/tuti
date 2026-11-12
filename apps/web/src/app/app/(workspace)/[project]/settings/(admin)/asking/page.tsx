import { notFound } from "next/navigation";

import { AskingPropertySelect } from "@/components/asking-property-select";
import { SettingBlock, SettingsCard, SettingsPane } from "@/components/settings-card";
import { storedPropertyFormats } from "@/lib/property-formats";
import { getAdminProject } from "@/server/membership";
import { numberPropertyNames } from "@/server/operations/groups";

/** Settings → Users → Who's asking: the property Feedback totals over each post's voters (was in Access). */
export default async function AskingSettingsPage(props: PageProps<"/app/[project]/settings/asking">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const numbers = await numberPropertyNames(project.id);
  return (
    <SettingsPane title="Who's asking" description="A number property of your users (MRR, seats…), totalled over each post's voters on Feedback and the post, so you can see what a post is worth. Only your team sees it.">
      <SettingsCard>
        <SettingBlock>
          <AskingPropertySelect projectSlug={project.slug} property={project.askingProperty} properties={numbers} formats={storedPropertyFormats(project.propertyFormats)} />
        </SettingBlock>
      </SettingsCard>
    </SettingsPane>
  );
}
