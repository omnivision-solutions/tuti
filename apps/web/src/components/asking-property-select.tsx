"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setAskingProperty } from "@/server/groups";

/** "*" can't be a property's name here: it stands for none. */
const NONE = "*";

/** Settings → Access → Who's asking: the property Feedback totals over each post's voters, saved as it's picked. */
export function AskingPropertySelect({ projectSlug, property, properties }: { projectSlug: string; property: string | null; properties: string[] }) {
  const [pending, startTransition] = useTransition();
  const names = property && !properties.includes(property) ? [property, ...properties] : properties;
  const items = { [NONE]: "None", ...Object.fromEntries(names.map((name) => [name, name])) };
  return (
    <Select
      items={items}
      value={property ?? NONE}
      disabled={pending}
      onValueChange={(value) =>
        startTransition(async () => {
          const result = await setAskingProperty(projectSlug, value === NONE ? null : String(value));
          if (result.error) {
            toast.error(result.error);
          } else {
            toast.success(value === NONE ? "Feedback won't total a property" : `Feedback totals ${value} over each post's voters`);
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
