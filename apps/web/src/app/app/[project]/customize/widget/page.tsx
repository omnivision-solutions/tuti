import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";
import { notFound } from "next/navigation";

import { CustomizeShell } from "@/components/customize-shell";
import { PlanNotice } from "@/components/plan-notice";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { WidgetPreview } from "@/components/widget-preview";
import { WidgetSettings } from "@/components/widget-settings";
import { appUrl, portalUrl } from "@/lib/hosts";
import { getAdminProject } from "@/server/membership";
import { DEFAULT_WIDGET_COLOR, servedIcon, widgetSettings } from "@/server/operations/widget";

import { sectionTitle } from "../sections";

/** Customize → Widget: the launcher on the team's site, beside the widget open on a stand-in for it. */
export default async function WidgetPage(props: PageProps<"/app/[project]/customize/widget">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [settings, { plan }] = await Promise.all([
    widgetSettings({ id: project.id }),
    prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { plan: true } }),
  ]);
  const widget = settings!;
  const color = widget.color ?? DEFAULT_WIDGET_COLOR;
  // Set before the plan dropped: kept, but the launcher shows the chat bubble.
  const kept = widget.icon !== "chat";
  const iconLocked = !planIncludes(plan, "launcherIcon") && (
    <PlanNotice feature="launcherIcon" projectSlug={slug} admin>
      {kept && "Until it's back, the launcher shows the chat bubble; the icon you picked is kept."}
    </PlanNotice>
  );
  return (
    <CustomizeShell
      backHref={`/app/${slug}/customize`}
      title={sectionTitle("widget")}
      preview={{
        custom: (
          <WidgetPreview src={`${portalUrl(slug)}/widget`} label={widget.label} color={color} position={widget.position} {...servedIcon(widget, plan)} />
        ),
      }}
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
          <CardDescription>The round button&apos;s name, colour, corner and icon, and quick links on the panel&apos;s Home.</CardDescription>
        </CardHeader>
        <CardContent>
          <WidgetSettings
            projectSlug={slug}
            label={widget.label}
            color={color}
            defaultColor={DEFAULT_WIDGET_COLOR}
            position={widget.position}
            links={widget.links}
            icon={widget.icon}
            iconImage={widget.iconImage}
            iconLocked={iconLocked}
          />
        </CardContent>
      </Card>
    </CustomizeShell>
  );
}
