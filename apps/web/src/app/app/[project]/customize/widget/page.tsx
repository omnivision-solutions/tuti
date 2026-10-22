import { notFound } from "next/navigation";

import { CustomizeShell } from "@/components/customize-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { WidgetPreview } from "@/components/widget-preview";
import { WidgetSettings } from "@/components/widget-settings";
import { appUrl, portalUrl } from "@/lib/hosts";
import { getAdminProject } from "@/server/membership";
import { DEFAULT_WIDGET_COLOR, widgetSettings } from "@/server/operations/widget";

import { sectionTitle } from "../sections";

/** Customize → Widget: the launcher on the team's site, beside the widget open on a stand-in for it. */
export default async function WidgetPage(props: PageProps<"/app/[project]/customize/widget">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const widget = (await widgetSettings({ id: project.id }))!;
  const color = widget.color ?? DEFAULT_WIDGET_COLOR;
  return (
    <CustomizeShell
      backHref={`/app/${slug}/customize`}
      title={sectionTitle("widget")}
      preview={{ custom: <WidgetPreview src={`${portalUrl(slug)}/widget`} label={widget.label} color={color} position={widget.position} /> }}
    >
      <Card>
        <CardHeader>
          <CardTitle>Add it to your site</CardTitle>
          <CardDescription>A button on your site that opens feedback, what&apos;s new and docs in a panel. Add it with one script tag:</CardDescription>
        </CardHeader>
        <CardContent>
          <code className="block rounded-lg bg-muted p-3 text-xs break-all">
            {`<script src="${appUrl().origin}/widget.js" data-project="${slug}" async></script>`}
          </code>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Launcher</CardTitle>
          <CardDescription>The button&apos;s label, colour and corner, and quick links at the top of the panel.</CardDescription>
        </CardHeader>
        <CardContent>
          <WidgetSettings
            projectSlug={slug}
            label={widget.label}
            color={color}
            defaultColor={DEFAULT_WIDGET_COLOR}
            position={widget.position}
            links={widget.links}
          />
        </CardContent>
      </Card>
    </CustomizeShell>
  );
}
