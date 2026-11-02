"use client";

import { useEffect, useRef, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { propertyLabel, type PropertyFormats, suggestedAsking } from "@/lib/property-formats";
import { setAskingProperty } from "@/server/groups";

/** Properties by name, behind a prefix, so none can be taken for None. */
const NONE = "none";
const valueOf = (name: string) => `property:${name}`;

/**
 * Settings → Access → Who's asking: the property Feedback totals over each post's voters, saved as it's picked. While
 * it's None, the first of the users' amounts (a number or money as the team set it, else not an id or a time: suggestedAsking) is
 * offered in one click;
 * it's the team's to pick, so it isn't set.
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
  const trigger = useRef<HTMLButtonElement>(null);
  // Once the suggestion's pick is saved its button is gone: focus goes to what it set, not the page.
  const refocus = useRef(false);
  useEffect(() => {
    if (!pending && refocus.current) {
      refocus.current = false;
      trigger.current?.focus();
    }
  }, [pending]);
  const names = property && !properties.includes(property) ? [property, ...properties] : properties;
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
  const suggested = property === null ? suggestedAsking(properties, formats) : undefined;
  return (
    <div className="flex flex-col gap-3">
      <Select
        items={items}
        value={property === null ? NONE : valueOf(property)}
        disabled={pending}
        onValueChange={(value) => pick(value === NONE ? null : String(value).slice(valueOf("").length))}
      >
        <SelectTrigger ref={trigger} className="w-full sm:w-48" aria-label="Property to total">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(items).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {suggested !== undefined && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
          <p className="wrap-anywhere">Your users have {propertyLabel(formats, suggested)}, a number Feedback can total.</p>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            focusableWhenDisabled
            onClick={() => {
              refocus.current = true;
              pick(suggested);
            }}
          >
            Use {propertyLabel(formats, suggested)}
          </Button>
        </div>
      )}
    </div>
  );
}
