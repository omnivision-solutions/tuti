"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setAskingProperty } from "@/server/groups";

/** Properties by name, behind a prefix, so none can be taken for None. */
const NONE = "none";
const valueOf = (name: string) => `property:${name}`;

/** Settings → Access → Who's asking: the property Feedback totals over each post's voters, saved as it's picked. */
export function AskingPropertySelect({ projectSlug, property, properties }: { projectSlug: string; property: string | null; properties: string[] }) {
  const [pending, startTransition] = useTransition();
  const names = property && !properties.includes(property) ? [property, ...properties] : properties;
  const items = { [NONE]: "None", ...Object.fromEntries(names.map((name) => [valueOf(name), name])) };
  return (
    <Select
      items={items}
      value={property === null ? NONE : valueOf(property)}
      disabled={pending}
      onValueChange={(value) =>
        startTransition(async () => {
          const name = value === NONE ? null : String(value).slice(valueOf("").length);
          const result = await setAskingProperty(projectSlug, name);
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success(name === null ? "Feedback won't total a property" : `Feedback totals ${name} over each post's voters`);
          }
        })
      }
    >
      <SelectTrigger className="w-full sm:w-48" aria-label="Property to total">
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
  );
}
