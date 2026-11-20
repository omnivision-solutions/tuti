import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";
import { notFound } from "next/navigation";

import { CopyButton } from "@/components/copy-button";
import { PortalSettingsPane } from "@/components/portal-settings-pane";
import { MessagesOffNotice } from "@/components/inbox/messages-off";
import { PlanNotice } from "@/components/plan-notice";
import { SettingBlock, SettingsCard } from "@/components/settings-card";
import { WidgetPreview } from "@/components/widget-preview";
import { WidgetSettings } from "@/components/widget-settings";
import { appUrl, portalUrl } from "@/lib/hosts";
import { getAdminProject } from "@/server/membership";
import { answersEnabled } from "@/server/operations/docs-ask";
import { DEFAULT_WIDGET_COLOR, defaultLauncherColor, servedIcon, widgetSettings } from "@/server/operations/widget";

export const metadata: Metadata = { title: "Widget · Settings" };

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
  const script = `<script src="${appUrl().origin}/api/widget.js" data-project="${slug}" async></script>`;
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
      <div className="flex flex-col gap-4">
        <SettingsCard title="Install">
          <SettingBlock className="gap-2">
            <code className="block rounded-lg bg-muted px-3 py-2 text-xs break-all">{script}</code>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">Paste before &lt;/body&gt;.</span>
              <CopyButton value={script} label="the widget's script tag" />
            </div>
          </SettingBlock>
        </SettingsCard>
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
      </div>
    </PortalSettingsPane>
  );
}
