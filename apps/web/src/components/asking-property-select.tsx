"use client";

import { useId, useTransition } from "react";
import { toast } from "sonner";

import { SettingRow } from "@/components/settings-card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { propertyLabel, type PropertyFormats, suggestedAsking } from "@/lib/property-formats";
import { setAskingProperty } from "@/server/groups";

/** Properties by name, behind a prefix, so none can be taken for None. */
const NONE = "none";
const valueOf = (name: string) => `property:${name}`;

/**
 * Settings → Users → Who's asking: the property Feedback totals over each post's voters, saved as it's picked. While
 * it's None, the first of the users' amounts (a number or money as the team set it, else not an id or a time:
 * suggestedAsking) is the first property in the list, marked Suggested; it's the team's to pick, so it isn't set.
 */
export function AskingPropertySelect({
  projectSlug,
  property,
  properties,
  formats,
}: {
  projectSlug: string;
  property: string | null;
  properties: string[];
  formats: PropertyFormats;
}) {
  const [pending, startTransition] = useTransition();
  const id = useId();
  const suggested = property === null ? suggestedAsking(properties, formats) : undefined;
  const names =
    suggested !== undefined ? [suggested, ...properties.filter((name) => name !== suggested)] : property && !properties.includes(property) ? [property, ...properties] : properties;
  const items = { [NONE]: "None", ...Object.fromEntries(names.map((name) => [valueOf(name), propertyLabel(formats, name)])) };
  const pick = (name: string | null) =>
    startTransition(async () => {
      const result = await setAskingProperty(projectSlug, name);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(name === null ? "Feedback won't total a property" : `Feedback totals ${propertyLabel(formats, name)} over each post's voters`);
      }
    });
  return (
    <SettingRow label="Value of a post" description="Totals a number property over each post's voters. Only your team sees it." htmlFor={id}>
      <Select
        items={items}
        value={property === null ? NONE : valueOf(property)}
        disabled={pending}
        onValueChange={(value) => pick(value === NONE ? null : String(value).slice(valueOf("").length))}
      >
        <SelectTrigger id={id} aria-describedby={`${id}-description`} className="w-full @min-[34rem]/settings:w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(items).map(([value, label]) => (
            // A long name is cut short to fit the list, so "Suggested" stays in sight.
            <SelectItem key={value} value={value} className="*:first:min-w-0 *:first:shrink">
              <span className="truncate">{label}</span>
              {suggested !== undefined && value === valueOf(suggested) && <span className="text-muted-foreground">Suggested</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  );
}
