"use client";

import { ImageIcon, PlusIcon, XIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";

import { ImageField } from "@/components/branding-settings";
import { useCustomizeForm, useFieldChanged, usePreview } from "@/components/customize-shell";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { LauncherIcon } from "@/components/widget-preview";
import { cn } from "@/lib/utils";
import { WIDGET_ICON_CHOICES, type WidgetIcon } from "@/lib/widget-icons";
import { saveWidgetSettings } from "@/server/widget";

const MAX_LINKS = 5;

const ICON_NAMES: Record<WidgetIcon, string> = { chat: "Chat", help: "Help", megaphone: "Megaphone", lightbulb: "Light bulb", image: "Your own" };

/**
 * Customize → Widget (saved with the panel's "Save changes"): the launcher on customers' sites, a round
 * button: its name, colour, corner, icon and quick links (see widget.update). `iconLocked` (the plan
 * notice) locks the icon where the plan doesn't include picking one; it isn't sent then, so it stays as set.
 */
export function WidgetSettings({
  projectSlug,
  label,
  color,
  defaultColor,
  position,
  links,
  icon: initialIcon,
  iconImage,
  iconLocked,
}: {
  projectSlug: string;
  label: string;
  /** `#rrggbb`, already the default when the project hasn't picked one. */
  color: string;
  defaultColor: string;
  position: "bottom-right" | "bottom-left";
  links: { label: string; url: string }[];
  icon: WidgetIcon;
  iconImage: { id: string; url: string } | null;
  iconLocked: ReactNode;
}) {
  const [picked, setPicked] = useState(color);
  const colorField = useRef<HTMLInputElement>(null);
  useFieldChanged(colorField, picked);
  const [icon, setIcon] = useState(initialIcon);
  const [uploading, setUploading] = useState(0);
  const preview = usePreview();
  const { state, form } = useCustomizeForm({
    save: (prev, formData) => saveWidgetSettings(projectSlug, prev, formData),
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
      },
    }),
    busy: uploading > 0,
  });

  return (
    <form {...form}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="widget-label">Button name</FieldLabel>
          <Input id="widget-label" name="label" defaultValue={label} required maxLength={30} autoComplete="off" />
          <FieldDescription>The button shows an icon: screen readers read its name, and it&apos;s the tooltip.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="widget-color">Colour</FieldLabel>
          <div className="flex items-center gap-3">
            <input
              ref={colorField}
              id="widget-color"
              name="color"
              type="color"
              value={picked}
              onChange={(event) => setPicked(event.target.value)}
              className="h-9 w-14 cursor-pointer rounded-md border bg-transparent p-1"
            />
            {picked !== defaultColor && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setPicked(defaultColor)}>
                Use the default green
              </Button>
            )}
          </div>
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">Position</legend>
          <div className="flex flex-wrap gap-4">
            {(
              [
                ["bottom-right", "Bottom right"],
                ["bottom-left", "Bottom left"],
              ] as const
            ).map(([value, name]) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input type="radio" name="position" value={value} defaultChecked={position === value} className="size-4 accent-primary" />
                {name}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset disabled={Boolean(iconLocked)} className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">Icon</legend>
          {iconLocked}
          <div className="flex flex-wrap gap-2">
            {WIDGET_ICON_CHOICES.map((value) => (
              <label
                key={value}
                className="flex w-20 cursor-pointer flex-col items-center gap-1 rounded-lg border p-2 text-xs has-checked:border-primary has-checked:bg-accent has-focus-visible:ring-2 has-focus-visible:ring-ring has-disabled:cursor-not-allowed has-disabled:opacity-50"
              >
                <input type="radio" name="icon" value={value} checked={icon === value} onChange={() => setIcon(value)} className="sr-only" />
                {value === "image" ? <ImageIcon aria-hidden className="size-6" /> : <LauncherIcon name={value} className="size-6" />}
                {ICON_NAMES[value]}
              </label>
            ))}
          </div>
          {/* Kept while another icon is picked, so going back to it before saving keeps the upload. */}
          <div className={cn(icon !== "image" && "hidden")}>
            <ImageField
              projectSlug={projectSlug}
              name="iconImage"
              label="Your icon"
              description="A square image with a transparent background works best. It shows at 28 pixels."
              image={iconImage}
              look="light"
              onBusy={(delta) => setUploading((count) => count + delta)}
              // Without its image, the launcher shows the chat bubble: so does the picker (and what's saved).
              onRemove={() => setIcon("chat")}
            />
          </div>
        </fieldset>
        <LinkRows
          name="link"
          item="Link"
          legend="Quick links"
          description={`Up to ${MAX_LINKS} links on the widget's Home, such as your status page or docs.`}
          links={links}
        />
        {state.error && <FieldError>{state.error}</FieldError>}
      </FieldGroup>
    </form>
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
