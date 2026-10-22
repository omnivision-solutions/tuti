"use client";

import { useId } from "react";

import { useBrandingForm } from "@/components/branding-settings";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { type ContentActions, DOCS_SUBTITLE_MAX, DOCS_TITLE_MAX, type DocsHome } from "@/lib/portal-look";

/** A setting that's on or off: its name, what it does, and a switch, in a row. */
function SwitchRow({ name, label, description, defaultChecked }: { name: string; label: string; description?: string; defaultChecked: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      <Switch id={id} name={name} defaultChecked={defaultChecked} className="mt-0.5" />
    </div>
  );
}

const on = (data: FormData, name: string) => data.get(name) === "on";

/** Customize → Content actions: the "Copy page" menu on articles, what's in it, and the "Updated" date (see branding.update's contentActions). */
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
    <form {...form} className="flex flex-col gap-6">
      <input type="hidden" name="part" value="contentActions" />
      <section aria-labelledby="content-actions-menu" className="flex flex-col gap-4 rounded-xl border p-4">
        <h2 id="content-actions-menu" className="font-semibold">
          Page actions
        </h2>
        <SwitchRow
          name="menu"
          label="Show the page actions menu"
          description="Lets readers copy an article or take it to an AI tool."
          defaultChecked={actions.menu}
        />
        <SwitchRow name="copyMarkdown" label="Copy as Markdown" defaultChecked={actions.copyMarkdown} />
        <SwitchRow name="chatGpt" label="Open in ChatGPT" defaultChecked={actions.chatGpt} />
        <SwitchRow name="claude" label="Open in Claude" defaultChecked={actions.claude} />
      </section>
      <section aria-labelledby="content-actions-date" className="flex flex-col gap-4 rounded-xl border p-4">
        <h2 id="content-actions-date" className="font-semibold">
          Last updated date
        </h2>
        <SwitchRow name="updatedDate" label="Show the last updated date" description="When each article was last published, under its title." defaultChecked={actions.updatedDate} />
      </section>
      {state.error && <FieldError>{state.error}</FieldError>}
    </form>
  );
}

/** Customize → Docs home: the heading above its search box and its popular articles (see branding.update's docsHome). */
export function DocsHomeSettings({ projectSlug, home }: { projectSlug: string; home: DocsHome }) {
  const { state, form } = useBrandingForm(projectSlug, "Docs home saved", (data) => ({
    docsHome: { title: String(data.get("title") ?? ""), subtitle: String(data.get("subtitle") ?? ""), popular: on(data, "popular") },
  }));
  return (
    <form {...form}>
      <input type="hidden" name="part" value="docsHome" />
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="docs-title">Title</FieldLabel>
          <Input id="docs-title" name="title" defaultValue={home.title} maxLength={DOCS_TITLE_MAX} placeholder="Docs" autoComplete="off" />
          <FieldDescription>Above the search box on your docs&apos; home. Empty for &ldquo;Docs&rdquo;.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="docs-subtitle">Subtitle</FieldLabel>
          <Textarea id="docs-subtitle" name="subtitle" defaultValue={home.subtitle} maxLength={DOCS_SUBTITLE_MAX} rows={3} placeholder="Guides and answers to common questions." />
        </Field>
        <SwitchRow
          name="popular"
          label="Show popular articles"
          description="Your most-read articles of the last 30 days, under the search box."
          defaultChecked={home.popular}
        />
        {state.error && <FieldError>{state.error}</FieldError>}
      </FieldGroup>
    </form>
  );
}
