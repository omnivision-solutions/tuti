"use client";

import { PlusIcon, XIcon } from "lucide-react";
import { useActionState, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { keepingFields } from "@/lib/forms";
import type { FormState } from "@/server/form-state";
import { saveWidgetSettings } from "@/server/widget";

const MAX_LINKS = 5;

/** The launcher on customers' sites: label, colour, corner and quick links (see widget.update). */
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
  const [rows, setRows] = useState(() => links.map((link, i) => ({ ...link, key: i })));
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveWidgetSettings(projectSlug, prev, formData);
    if (!result.error) {
      toast.success("Widget saved");
    }
    return result;
  }, {});

  return (
    <form {...keepingFields(action)}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="widget-label">Button label</FieldLabel>
          <Input id="widget-label" name="label" defaultValue={label} required maxLength={30} autoComplete="off" />
        </Field>
        <Field>
          <FieldLabel htmlFor="widget-color">Colour</FieldLabel>
          <div className="flex items-center gap-3">
            <input
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
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Quick links</legend>
          <p className="text-sm text-muted-foreground">
            Up to {MAX_LINKS} links at the top of the widget, such as your status page or docs.
          </p>
          {rows.map((row, i) => (
            <div key={row.key} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
              <Input
                name="linkLabel"
                aria-label={`Link ${i + 1} label`}
                placeholder="Label"
                defaultValue={row.label}
                maxLength={40}
                autoComplete="off"
                className="sm:w-40"
              />
              <Input
                name="linkUrl"
                type="url"
                aria-label={`Link ${i + 1} URL`}
                placeholder="https://"
                defaultValue={row.url}
                autoComplete="off"
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove link ${i + 1}`}
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
              Add link
            </Button>
          )}
        </fieldset>
        {state.error && <FieldError>{state.error}</FieldError>}
        <Button type="submit" disabled={pending} className="self-end">
          {pending ? "Saving…" : "Save widget"}
        </Button>
      </FieldGroup>
    </form>
  );
}
