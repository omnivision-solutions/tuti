"use client";

import { useId } from "react";

import { useBrandingForm } from "@/components/branding-settings";
import { SettingRow, SettingsCard } from "@/components/settings-card";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { type ContentActions, DOCS_HEADING, DOCS_SUBTITLE_MAX, DOCS_TITLE_MAX, type DocsHome } from "@/lib/portal-look";

/** A setting that's on or off: its name, what it does, and a switch, in a row. More props go to the switch. */
export function SwitchRow({
  name,
  label,
  description,
  ...props
}: { name: string; label: string; description?: string } & Omit<React.ComponentProps<typeof Switch>, "id" | "name" | "className">) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <Switch id={id} name={name} className="mt-0.5" {...props} />
    </div>
  );
}

const on = (data: FormData, name: string) => data.get(name) === "on";

/** A switch in Content actions' card: its name on the left, the switch on the right, on phones too. */
function ActionRow({ name, label, info, on }: { name: string; label: string; info?: string; on: boolean }) {
  const id = `content-actions-${name}`;
  return (
    <SettingRow label={label} htmlFor={id} info={info} inline>
      <Switch id={id} name={name} defaultChecked={on} />
    </SettingRow>
  );
}

/**
 * Settings → Portal → Content actions: the "Copy page" menu on articles, what's in it (indented under it), and the
 * "Updated" date (see branding.update's contentActions), one switch a row in one card. The preview shows what each does.
 */
export function ContentActionsSettings({ projectSlug, actions }: { projectSlug: string; actions: ContentActions }) {
  const { state, form } = useBrandingForm(projectSlug, "Content actions saved", (data) => ({
    contentActions: {
      menu: on(data, "menu"),
      copyMarkdown: on(data, "copyMarkdown"),
      chatGpt: on(data, "chatGpt"),
      claude: on(data, "claude"),
      updatedDate: on(data, "updatedDate"),
    },
  }));
  return (
    <form {...form} className="flex flex-col gap-3">
      <input type="hidden" name="part" value="contentActions" />
      <SettingsCard>
        <ActionRow name="menu" label="Page actions menu" on={actions.menu} />
        <div role="group" aria-label="In the page actions menu" className="flex flex-col divide-y pl-6 *:py-2.5">
          <ActionRow name="copyMarkdown" label="Copy as Markdown" on={actions.copyMarkdown} />
          <ActionRow name="chatGpt" label="Open in ChatGPT" on={actions.chatGpt} />
          <ActionRow name="claude" label="Open in Claude" on={actions.claude} />
        </div>
        <ActionRow name="updatedDate" label="Last updated date" info="Under each article's heading: when you last published changes to it. None shows until you do." on={actions.updatedDate} />
      </SettingsCard>
      {state.error && <FieldError>{state.error}</FieldError>}
    </form>
  );
}

/** Customize → Docs home: the heading at its top and its popular articles (see branding.update's docsHome). */
export function DocsHomeSettings({ projectSlug, home }: { projectSlug: string; home: DocsHome }) {
  const { state, form } = useBrandingForm(projectSlug, "Docs home saved", (data) => ({
    docsHome: { title: String(data.get("title") ?? ""), subtitle: String(data.get("subtitle") ?? ""), popular: on(data, "popular") },
  }));
  return (
    <form {...form} className="flex flex-col gap-3">
      <input type="hidden" name="part" value="docsHome" />
      <SettingsCard>
        <SettingRow label="Title" htmlFor="docs-title">
          <Input id="docs-title" name="title" defaultValue={home.title} maxLength={DOCS_TITLE_MAX} placeholder={DOCS_HEADING.title} autoComplete="off" />
        </SettingRow>
        <SettingRow label="Subtitle" htmlFor="docs-subtitle">
          <Textarea id="docs-subtitle" name="subtitle" defaultValue={home.subtitle} maxLength={DOCS_SUBTITLE_MAX} rows={3} placeholder={DOCS_HEADING.subtitle} />
        </SettingRow>
        <SettingRow label="Popular articles" htmlFor="docs-popular" info="Each tab's most-read articles of the last 30 days, above its collections, once three or more have been read." inline>
          <Switch id="docs-popular" name="popular" defaultChecked={home.popular} />
        </SettingRow>
      </SettingsCard>
      {state.error && <FieldError>{state.error}</FieldError>}
    </form>
  );
}
