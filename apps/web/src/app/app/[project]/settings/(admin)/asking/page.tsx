import { notFound } from "next/navigation";

import { AskingPropertySelect } from "@/components/asking-property-select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
    <Card role="region" aria-labelledby="asking-title">
      <CardHeader>
        <CardTitle id="asking-title">Who&apos;s asking</CardTitle>
        <CardDescription>
          A number property of your users (MRR, seats…), totalled over each post&apos;s voters on Feedback and the post, so you can see what a
          post is worth. Only your team sees it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AskingPropertySelect projectSlug={project.slug} property={project.askingProperty} properties={numbers} />
      </CardContent>
    </Card>
  );
}
