"use client";

import { PlusIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { useCustomizeForm, useFieldChanged, usePreview } from "@/components/customize-shell";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { saveWidgetSettings } from "@/server/widget";

const MAX_LINKS = 5;

/** Customize → Widget (saved with the panel's "Save changes"): the launcher on customers' sites: label, colour, corner and quick links (see widget.update). */
export function WidgetSettings({
  projectSlug,
  label,
  color,
  defaultColor,
  position,
  links,
}: {
  projectSlug: string;
  label: string;
  /** `#rrggbb`, already the default when the project hasn't picked one. */
  color: string;
  defaultColor: string;
  position: "bottom-right" | "bottom-left";
  links: { label: string; url: string }[];
}) {
  const [picked, setPicked] = useState(color);
  const colorField = useRef<HTMLInputElement>(null);
  useFieldChanged(colorField, picked);
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
      },
    }),
  });

  return (
    <form {...form}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="widget-label">Button label</FieldLabel>
          <Input id="widget-label" name="label" defaultValue={label} required maxLength={30} autoComplete="off" />
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
        <LinkRows
          name="link"
          item="Link"
          legend="Quick links"
          description={`Up to ${MAX_LINKS} links at the top of the widget, such as your status page or docs.`}
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
