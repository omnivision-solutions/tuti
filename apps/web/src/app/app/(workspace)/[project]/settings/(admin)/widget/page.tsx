import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";
import { notFound } from "next/navigation";

import { CopyField } from "@/components/copy-button";
import { PortalSettingsPane } from "@/components/portal-settings-pane";
import { MessagesOffNotice } from "@/components/inbox/messages-off";
import { PlanNotice } from "@/components/plan-notice";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { WidgetPreview } from "@/components/widget-preview";
import { WidgetSettings } from "@/components/widget-settings";
import { appUrl, portalUrl } from "@/lib/hosts";
import { getAdminProject } from "@/server/membership";
import { answersEnabled } from "@/server/operations/docs-ask";
import { DEFAULT_WIDGET_COLOR, defaultLauncherColor, servedIcon, widgetSettings } from "@/server/operations/widget";

/** Settings → Portal → Widget: the launcher on the team's site and the panel's Home, beside the widget open on a stand-in for it. */
export default async function WidgetPage(props: PageProps<"/app/[project]/settings/widget">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [settings, { plan, supportInbox, brandColor }] = await Promise.all([
    widgetSettings({ id: project.id }),
    prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { plan: true, supportInbox: true, brandColor: true } }),
  ]);
  const widget = settings!;
  // Without a colour of its own, the launcher is the portal's accent (Settings → Branding), else the brand green.
  const defaultColor = defaultLauncherColor(brandColor);
  const color = widget.color ?? defaultColor;
  // Set before the plan dropped: kept, but the launcher shows the chat bubble.
  const kept = widget.icon !== "chat";
  const iconLocked = !planIncludes(plan, "launcherIcon") && (
    <PlanNotice feature="launcherIcon" projectSlug={slug} admin>
      {kept && "Until it's back, the launcher shows the chat bubble; the icon you picked is kept."}
    </PlanNotice>
  );
  return (
    <PortalSettingsPane
      page="widget"
      preview={{
        custom: (
          <WidgetPreview src={`${portalUrl(slug)}/widget`} label={widget.label} color={color} position={widget.position} {...servedIcon(widget, plan)} />
        ),
      }}
    >
      {!supportInbox && <MessagesOffNotice projectSlug={slug} admin />}
      <Card>
        <CardHeader>
          <CardTitle>Add it to your site</CardTitle>
          <CardDescription>A button on your site that opens feedback, what&apos;s new and docs in a panel. Add it with one script tag:</CardDescription>
        </CardHeader>
        <CardContent>
          <CopyField label="Before </body>" name="the widget's script tag" value={`<script src="${appUrl().origin}/api/widget.js" data-project="${slug}" async></script>`} />
        </CardContent>
      </Card>
      <WidgetSettings
        projectSlug={slug}
        label={widget.label}
        color={color}
        defaultColor={defaultColor}
        // The brand green kept as its own while it's the default anyway (picked while the accent was another colour) follows it.
        colorFollows={!widget.color || (widget.color === DEFAULT_WIDGET_COLOR && defaultColor === DEFAULT_WIDGET_COLOR)}
        defaultColorLabel={defaultColor !== DEFAULT_WIDGET_COLOR ? "Use the accent colour" : undefined}
        position={widget.position}
        links={widget.links}
        icon={widget.icon}
        iconImage={widget.iconImage}
        iconLocked={iconLocked}
        title={widget.title}
        greeting={widget.greeting}
        hidden={widget.hidden}
        onPortal={widget.onPortal}
        // Under a path of the team's site, or Tuti's own portal under the app's.
        aiFirst={answersEnabled() ? widget.aiFirst : null}
      />
    </PortalSettingsPane>
  );
}
