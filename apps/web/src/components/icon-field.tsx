"use client";

import { cn } from "cn";
import type { IconName } from "lucide-react/dynamic";
import dynamic from "next/dynamic";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// Neither comes with the page: the picker's code and Lucide's names load when it opens, an icon's drawing when it's drawn.
const IconPicker = dynamic(() => import("@/components/icon-picker"), {
  ssr: false,
  loading: () => <p className="p-2 text-sm text-muted-foreground">Loading icons…</p>,
});
const DynamicIcon = dynamic(() => import("lucide-react/dynamic").then((m) => m.DynamicIcon), { ssr: false });

/** A Lucide icon by name, in the app (readers get CollectionIcon, drawn on the server). Unknown names draw nothing. */
export function LucideIcon({ name, className }: { name: string; className?: string }) {
  return <DynamicIcon name={name as IconName} aria-hidden className={cn("size-4 shrink-0", className)} />;
}

/**
 * A form's `icon` field (a Lucide icon's name, empty for none): "Add icon" opens a searchable grid; "Remove icon".
 * A stored icon Lucide no longer has (`known` false) shows as none, but is sent unchanged until another is picked.
 */
export function IconField({ defaultValue, known = true }: { defaultValue: string | null; known?: boolean }) {
  const [value, setIcon] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const icon = value === defaultValue && !known ? null : value;
  return (
    <Field>
      <input type="hidden" name="icon" value={value ?? ""} />
      <div className="flex flex-wrap gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={<Button type="button" variant="outline" size="sm" aria-label={icon ? `Change icon (${icon.replaceAll("-", " ")})` : undefined} />}
          >
            {icon ? (
              <>
                <LucideIcon name={icon} />
                Change icon
              </>
            ) : (
              "Add icon"
            )}
          </PopoverTrigger>
          <PopoverContent aria-label="Pick an icon" initialFocus={false}>
            <IconPicker
              value={icon}
              onPick={(name) => {
                setIcon(name);
                setOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
        {icon && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setIcon(null)}>
            Remove icon
          </Button>
        )}
      </div>
    </Field>
  );
}
