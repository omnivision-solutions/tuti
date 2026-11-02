import { notFound } from "next/navigation";

import { PropertyFormatsList } from "@/components/property-formats";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { storedPropertyFormats } from "@/lib/property-formats";
import { getAdminProject } from "@/server/membership";
import { numberPropertyNames, propertyNames } from "@/server/operations/groups";

/** Settings → Users → User properties: how each of the users' properties shows (was in Access). */
export default async function PropertiesSettingsPage(props: PageProps<"/app/[project]/settings/properties">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [properties, numbers] = await Promise.all([propertyNames(project.id), numberPropertyNames(project.id)]);
  const formats = storedPropertyFormats(project.propertyFormats);
  // Those set before too, and Who's asking's, even past the first 200 names.
  const listed = [...new Set([...properties, ...Object.keys(formats), ...(project.askingProperty ? [project.askingProperty] : [])])].sort();
  return (
    <Card role="region" aria-labelledby="properties-title">
      <CardHeader>
        <CardTitle id="properties-title">User properties</CardTitle>
        <CardDescription>
          How your users&apos; properties show on Users, beside a conversation and in Who&apos;s asking: a name of your own (MRR for{" "}
          <code>mrr</code>) and a format.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {listed.length > 0 ? (
          <PropertyFormatsList projectSlug={project.slug} properties={listed} numbers={numbers} formats={formats} />
        ) : (
          <p className="text-sm text-muted-foreground">
            None yet. Your app adds them when it signs people in with single sign-on, or sends them with the API (users.sync).
          </p>
        )}
      </CardContent>
    </Card>
  );
}
