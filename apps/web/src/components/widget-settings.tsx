"use client";

import { ImageIcon, PlusIcon, UploadIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { useImageUpload } from "@/components/branding-settings";
import { ColorField } from "@/components/color-field";
import { useCustomizeForm, useFieldChanged, usePreview } from "@/components/customize-shell";
import { SettingRow, SettingsCard } from "@/components/settings-card";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { UpgradeDialog } from "@/components/upgrade-dialog";
import { LauncherIcon } from "@/components/widget-preview";
import { linksFrom } from "@/lib/forms";
import type { UpgradePrompt } from "@/lib/upgrade-prompt";
import { MAX_WIDGET_HOME_TEXT, WIDGET_PARTS, type WidgetPart } from "@/lib/portal-look";
import { cn } from "@/lib/utils";
import { WIDGET_ICON_CHOICES, type WidgetIcon } from "@/lib/widget-icons";
import { saveWidgetSettings } from "@/server/widget";

const MAX_LINKS = 5;

const ICON_NAMES: Record<WidgetIcon, string> = { chat: "Chat", help: "Help", megaphone: "Megaphone", lightbulb: "Light bulb", image: "Your own" };

/** The icon's options: the icon itself (the column is narrow), named for screen readers. */
const ICONS = WIDGET_ICON_CHOICES.map((value) => ({
  value,
  label: <span className="sr-only">{ICON_NAMES[value]}</span>,
  icon: value === "image" ? <ImageIcon aria-hidden /> : <LauncherIcon name={value} />,
}));

/** The launcher's corner, as the sides of the screen are. */
const POSITIONS = [
  { value: "bottom-left", label: "Left" },
  { value: "bottom-right", label: "Right" },
] as const;

/** A text field on a row's right: narrower in the settings column at its narrowest, so its label keeps one line. */
const ROW_INPUT = "w-28 @min-[20rem]/settings:w-40";

/** Each part of the panel the team can turn off: its switch's name, and behind its ⓘ what it needs before it shows. */
const PARTS: Record<WidgetPart, { label: string; info?: string }> = {
  docs: { label: "Help center", info: "Search and suggested articles on Home, and its tab, once you've published articles." },
  messages: { label: "Messages", info: "“Send us a message” on Home, and its tab, once the support inbox is on." },
  feedback: { label: "Feedback" },
  whatsNew: { label: "What's new" },
};

/**
 * Settings → Widget (saved with the pane's "Save changes"): the launcher on customers' sites, a round
 * button: its name, colour, corner and icon; and the panel's Home: its greeting and heading, the parts it
 * shows and quick links (see widget.update). A setting is a row (docs/design.md → Settings rows); what the
 * preview beside them can't show is behind a row's ⓘ. Where the plan doesn't include picking an icon
 * (`upgrade`), its options look as usual, the row says which plan does, and choosing one opens the upgrade
 * prompt; the one set is kept (going back to the chat bubble works, as on the server).
 */
export function WidgetSettings({
  projectSlug,
  label,
  color,
  defaultColor,
  defaultColorLabel,
  colorFollows,
  position,
  links,
  icon: initialIcon,
  iconImage,
  upgrade,
  title,
  greeting,
  hidden,
  onPortal,
  popup,
  aiFirst,
}: {
  projectSlug: string;
  label: string;
  /** `#rrggbb`, already the default when the project hasn't picked one. */
  color: string;
  defaultColor: string;
  /** The button that picks `defaultColor` again (ColorField). */
  defaultColorLabel?: string;
  /** The launcher has no colour of its own: it follows the default (ColorField's `follows`). */
  colorFollows: boolean;
  position: "bottom-right" | "bottom-left";
  links: { label: string; url: string }[];
  icon: WidgetIcon;
  iconImage: { id: string; url: string } | null;
  /** Where the plan doesn't include picking an icon: the upgrade prompt its options open. */
  upgrade: UpgradePrompt | null;
  title: string;
  greeting: string;
  hidden: WidgetPart[];
  onPortal: boolean;
  popup: boolean;
  /** Null where the server has no AI answers: the switch isn't there (it would do nothing). */
  aiFirst: boolean | null;
}) {
  const [icon, setIcon] = useState(initialIcon);
  // A save refreshes the page with the icon as stored (a teammate's, perhaps): the picker follows it. Not to the one this
  // page sent: its refresh lands after "Widget saved", and would undo a pick made since (Remove right after saving).
  const [loaded, setLoaded] = useState(initialIcon);
  const [sent, setSent] = useState<FormDataEntryValue | null>(null);
  if (loaded !== initialIcon) {
    setLoaded(initialIcon);
    if (initialIcon === sent) {
      setSent(null);
    } else {
      setIcon(initialIcon);
    }
  }
  const [upgrading, setUpgrading] = useState(false);
  const iconChoices = useRef<HTMLDivElement>(null);
  const [uploading, setUploading] = useState(0);
  const preview = usePreview();
  const { state, form } = useCustomizeForm({
    save: async (prev, formData) => {
      setSent(formData.get("icon"));
      const result = await saveWidgetSettings(projectSlug, prev, formData);
      // Not saved: no refresh of its own is coming, so the next one (a teammate's) is followed.
      if (result.error) {
        setSent(null);
      }
      return result;
    },
    onSaved: () => {
      toast.success("Widget saved");
      preview.reload();
    },
    toDraft: (data) => ({
      widget: {
        label: String(data.get("label") ?? "") || label,
        color: String(data.get("color") ?? color),
        position: data.get("position") === "bottom-left" ? "bottom-left" : "bottom-right",
        // Locked, it isn't sent: the launcher shows the chat bubble.
        icon: (WIDGET_ICON_CHOICES as readonly unknown[]).includes(data.get("icon")) ? (data.get("icon") as WidgetIcon) : "chat",
        iconUrl: String(data.get("iconImageUrl") ?? "") || null,
        links: linksFrom(data, "link"),
        title: String(data.get("title") ?? ""),
        greeting: String(data.get("greeting") ?? ""),
        hidden: WIDGET_PARTS.filter((part) => data.get(`show-${part}`) !== "on"),
      },
    }),
    busy: uploading > 0,
  });

  return (
    <form {...form} className="flex flex-col gap-4">
      <SettingsCard title="Button">
        <SettingRow label="Name" htmlFor="widget-label" info="The button shows an icon: screen readers read its name, and it's the tooltip." inline>
          <Input id="widget-label" name="label" defaultValue={label} required maxLength={30} autoComplete="off" className={ROW_INPUT} />
        </SettingRow>
        {/* Under its label: the button back to the default and a wrong hex's error need the column's width. */}
        <SettingRow label="Colour" htmlFor="widget-color">
          <ColorField id="widget-color" name="color" label="Colour" color={color} defaultColor={defaultColor} defaultLabel={defaultColorLabel} follows={colorFollows} />
        </SettingRow>
        <SettingRow label={<span id="widget-position">Position</span>} inline>
          <Segmented name="position" aria-labelledby="widget-position" defaultValue={position} options={POSITIONS} />
        </SettingRow>
        <div
          ref={iconChoices}
          // Without the plan, an arrow key only moves between the icons (it would choose, and so prompt at, each one it
          // passes); Space chooses.
          onKeyDown={(event) => {
            const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
            const radios = [...event.currentTarget.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
            const at = radios.indexOf(event.target as HTMLInputElement);
            if (upgrade && step && at >= 0) {
              event.preventDefault();
              radios[(at + step + radios.length) % radios.length].focus();
            }
          }}
        >
          <SettingRow
            label={<span id="widget-icon">Icon</span>}
            description={
              upgrade && (
                <span id="widget-icon-plan">
                  {upgrade.title}
                  {initialIcon !== "chat" && " Until it's back, the launcher shows the chat bubble; the icon you picked is kept."}
                </span>
              )
            }
            // With the plan's line, under it on phones: beside it, the line would be a word or two wide.
            inline={!upgrade}
          >
            <Segmented
              // Without the plan, the icon as loaded isn't sent (as on the server, it stays as set): from a stale page it
              // would replace a teammate's switch to the chat bubble, and need the plan.
              // The chat bubble needs no plan, so it's sent like any choice: saved, it stays the same field the form sent.
              name={upgrade && icon === initialIcon && icon !== "chat" ? "iconKept" : "icon"}
              aria-labelledby="widget-icon"
              aria-describedby={upgrade ? "widget-icon-plan" : undefined}
              value={icon}
              onValueChange={(value) => {
                // Not in the plan: the prompt, and the icon stays (the chat bubble and the one set can be chosen).
                if (upgrade && value !== "chat" && value !== initialIcon) {
                  setUpgrading(true);
                } else {
                  setIcon(value);
                }
              }}
              options={ICONS}
              className="@max-[20rem]/settings:*:px-2"
            />
          </SettingRow>
          {upgrade && <UpgradeDialog prompt={upgrade} open={upgrading} onOpenChange={setUpgrading} />}
          {/* Kept while another icon is picked, so going back to it before saving keeps the upload. Hidden without the
              plan, which a new image needs: the one there is kept. */}
          <div className={cn("border-t", (icon !== "image" || upgrade) && "hidden")}>
            <IconImageRow
              projectSlug={projectSlug}
              image={iconImage}
              onBusy={(delta) => setUploading((count) => count + delta)}
              // Without its image, the launcher shows the chat bubble: so does the picker (and what's saved).
              // Its row hides with it, so focus goes to that choice (not the Upload button hidden along with it).
              onRemove={() => {
                setIcon("chat");
                iconChoices.current?.querySelector<HTMLInputElement>('input[value="chat"]')?.focus();
              }}
            />
          </div>
        </div>
        <SettingRow label="Show on your portal" htmlFor="widget-on-portal" info="The launcher on every page of your portal too, opening the same panel as on your site." inline>
          <Switch id="widget-on-portal" name="onPortal" defaultChecked={onPortal} />
        </SettingRow>
        <SettingRow label="Show new announcements as a popup" htmlFor="widget-popup" info="A card by the button for a new announcement, once, for returning visitors who haven't seen it. Public portals only." inline>
          <Switch id="widget-popup" name="popup" defaultChecked={popup} />
        </SettingRow>
      </SettingsCard>
      <SettingsCard title="Panel">
        <SettingRow label="Greeting" htmlFor="widget-greeting" info="Leave it empty for “Hi there 👋”, with the person's first name once your site signs them in." inline>
          <Input id="widget-greeting" name="greeting" defaultValue={greeting} maxLength={MAX_WIDGET_HOME_TEXT} placeholder="Hi there 👋" autoComplete="off" className={ROW_INPUT} />
        </SettingRow>
        <SettingRow label="Heading" htmlFor="widget-title" inline>
          <Input id="widget-title" name="title" defaultValue={title} maxLength={MAX_WIDGET_HOME_TEXT} placeholder="How can we help?" autoComplete="off" className={ROW_INPUT} />
        </SettingRow>
        {WIDGET_PARTS.map((part) => (
          <SettingRow key={part} label={PARTS[part].label} htmlFor={`widget-show-${part}`} info={PARTS[part].info} inline>
            <Switch id={`widget-show-${part}`} name={`show-${part}`} defaultChecked={!hidden.includes(part)} />
          </SettingRow>
        ))}
        {aiFirst !== null && (
          <SettingRow
            label="Answer with AI first"
            htmlFor="widget-ai-first"
            info="Once you've published articles, a new message in Messages gets an answer from them right away, with Ask a person to send it to your team."
            inline
          >
            {/* Sent with the switch, so saving without it (the server has no AI answers) leaves the setting as it is. */}
            <input type="hidden" name="aiFirstShown" value="1" />
            <Switch id="widget-ai-first" name="aiFirst" defaultChecked={aiFirst} />
          </SettingRow>
        )}
        <QuickLinks links={links} />
      </SettingsCard>
      {state.error && <FieldError>{state.error}</FieldError>}
    </form>
  );
}

/**
 * The team's own launcher icon as a row, as Branding's images are: its thumbnail, "Upload" (the row takes a dropped
 * image too), and once there is one a button that removes it. What went wrong with a file shows under the row.
 */
function IconImageRow({
  projectSlug,
  image: initial,
  onBusy,
  onRemove,
}: {
  projectSlug: string;
  image: { id: string; url: string } | null;
  onBusy: (delta: number) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const { image, setImage, uploading, error, dragging, drop, inputs, pick } = useImageUpload({ projectSlug, name: "iconImage", id, image: initial, onBusy });
  return (
    <div {...drop} className={cn("transition-colors", dragging && "bg-soft")}>
      <SettingRow label="Your icon" htmlFor={id} info="A square image with a transparent background works best. It shows at 28 pixels." inline>
        {image ? (
          <span className="flex size-9 items-center justify-center rounded-lg border bg-background p-1">
            {/* eslint-disable-next-line @next/next/no-img-element -- from media storage, already resized */}
            <img src={image.url} alt="Your icon preview" className="max-h-full max-w-full object-contain" />
          </span>
        ) : (
          <span className="flex size-9 items-center justify-center rounded-lg border border-dashed bg-muted/50 text-muted-foreground">
            <ImageIcon aria-hidden className="size-4" />
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="Upload your icon"
          // Off while one uploads, yet focusable (aria-disabled): focus stays here through the upload, "Uploading…" read below.
          disabled={uploading}
          focusableWhenDisabled
          onClick={pick}
        >
          <UploadIcon />
          {/* The icon alone where the row has no room for the word (less of it beside "Remove"). */}
          <span className={image ? "@max-[22rem]/settings:sr-only" : "@max-[20rem]/settings:sr-only"}>Upload</span>
        </Button>
        {image && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Remove your icon"
            title="Remove"
            // Off while one uploads (its image would come back after), focusable all the same.
            disabled={uploading}
            focusableWhenDisabled
            onClick={() => {
              setImage(null);
              onRemove();
            }}
          >
            <XIcon />
          </Button>
        )}
        {inputs}
      </SettingRow>
      {uploading && (
        <p role="status" className="px-4 pb-3.5 text-sm text-muted-foreground">
          Uploading…
        </p>
      )}
      {error && <FieldError className="px-4 pb-3.5">{error}</FieldError>}
    </div>
  );
}

/**
 * The widget's quick links as a row: how many of the 5 there are and "Add", then a label and an https URL each, sent
 * as LinkRows sends them. A new link takes focus; removing one sends it to "Add" (the row it was on is gone).
 */
function QuickLinks({ links }: { links: { label: string; url: string }[] }) {
  const [rows, setRows] = useState(() => links.map((link, i) => ({ ...link, key: i })));
  const group = useRef<HTMLDivElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  // The link just added, to focus once it's on the page.
  const added = useRef<number | null>(null);
  useFieldChanged(group, rows);
  useEffect(() => {
    if (added.current !== null) {
      group.current?.querySelector<HTMLInputElement>(`[data-link="${added.current}"] input`)?.focus();
      added.current = null;
    }
  }, [rows]);
  return (
    <div ref={group} role="group" aria-labelledby="widget-links">
      <SettingRow
        label={
          <>
            <span id="widget-links">Quick links</span>{" "}
            <span className="font-normal text-muted-foreground">
              {rows.length}/{MAX_LINKS}
            </span>
          </>
        }
        info="On the widget's Home, such as your status page or docs."
        inline
      >
        <Button
          ref={add}
          type="button"
          variant="outline"
          size="sm"
          aria-label="Add link"
          // Off at 5, yet focusable: the fifth link's "Remove" sends focus back here.
          disabled={rows.length >= MAX_LINKS}
          focusableWhenDisabled
          onClick={() => {
            added.current = Math.max(-1, ...rows.map((r) => r.key)) + 1;
            setRows([...rows, { label: "", url: "", key: added.current }]);
          }}
        >
          <PlusIcon />
          Add
        </Button>
      </SettingRow>
      {rows.length > 0 && (
        <div className="flex flex-col gap-2 px-4 pb-3.5 @min-[34rem]/settings:px-5">
          {rows.map((row, i) => (
            <div key={row.key} data-link={row.key} className="flex items-start gap-2">
              {/* One over the other in the narrow column, where side by side the address would have no room. */}
              <div className="flex min-w-0 flex-1 flex-col gap-2 @min-[26rem]/settings:flex-row">
                <Input name="linkLabel" aria-label={`Link ${i + 1} label`} placeholder="Label" defaultValue={row.label} maxLength={40} autoComplete="off" className="@min-[26rem]/settings:w-40" />
                <Input name="linkUrl" type="url" aria-label={`Link ${i + 1} URL`} placeholder="https://" defaultValue={row.url} autoComplete="off" className="min-w-0 flex-1" />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove link ${i + 1}`}
                onClick={() => {
                  add.current?.focus();
                  setRows(rows.filter((r) => r.key !== row.key));
                }}
              >
                <XIcon />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Up to 5 rows of label and https URL, sent as `<name>Label` and `<name>Url` fields
 * (read with `linksFrom`). `item` names a row for screen readers ("Link 1 label").
 */
export function LinkRows({
  name,
  item,
  legend,
  description,
  links,
}: {
  name: string;
  item: string;
  /** Its title; with no `description`, for screen readers only (the box around it says what they're for). */
  legend: string;
  description?: string;
  links: { label: string; url: string }[];
}) {
  const [rows, setRows] = useState(() => links.map((link, i) => ({ ...link, key: i })));
  const fieldset = useRef<HTMLFieldSetElement>(null);
  useFieldChanged(fieldset, rows);
  return (
    <fieldset ref={fieldset} className="flex flex-col gap-2">
      <legend className={description ? "mb-1 text-sm font-medium" : "sr-only"}>{legend}</legend>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {rows.map((row, i) => (
        <div key={row.key} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          <Input
            name={`${name}Label`}
            aria-label={`${item} ${i + 1} label`}
            placeholder="Label"
            defaultValue={row.label}
            maxLength={40}
            autoComplete="off"
            className="sm:w-40"
          />
          <Input
            name={`${name}Url`}
            type="url"
            aria-label={`${item} ${i + 1} URL`}
            placeholder="https://"
            defaultValue={row.url}
            autoComplete="off"
            className="min-w-0 flex-1"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${item.toLowerCase()} ${i + 1}`}
            onClick={() => setRows(rows.filter((r) => r.key !== row.key))}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      {rows.length < MAX_LINKS && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setRows([...rows, { label: "", url: "", key: Math.max(-1, ...rows.map((r) => r.key)) + 1 }])}
        >
          <PlusIcon />
          Add {item.toLowerCase()}
        </Button>
      )}
    </fieldset>
  );
}
