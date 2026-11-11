"use client";

import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "cn";
import { SmilePlusIcon } from "lucide-react";
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
 * A stored icon Lucide no longer has (`known` false) shows as none, but is sent unchanged until another is picked
 * or it's removed.
 */
export function IconField({
  defaultValue,
  known = true,
  onChange,
  compact = false,
  named = false,
}: {
  defaultValue: string | null;
  known?: boolean;
  onChange?: () => void;
  /** A 36px square beside a name field (the icon, or a placeholder); Remove icon is in its picker. */
  compact?: boolean;
  /** Show the current icon name and a Change label in a separate settings row. */
  named?: boolean;
}) {
  const [value, setValue] = useState(defaultValue);
  // `onChange`: picked or removed (its hidden field changes without an event of its own).
  const setIcon = (icon: string | null) => {
    setValue(icon);
    onChange?.();
  };
  const [open, setOpen] = useState(false);
  const icon = value === defaultValue && !known ? null : value;
  if (compact) {
    return (
      <div className="relative shrink-0">
        <input type="hidden" name="icon" value={value ?? ""} />
        <Tooltip><Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <TooltipTrigger render={<Button
                type="button"
                variant={named ? "ghost" : "outline"}
                size={named ? "sm" : "icon"}
                aria-label={icon ? named ? `${icon.replaceAll("-", " ")} Change icon` : `Change icon (${icon.replaceAll("-", " ")})` : "Add icon"}
                className={cn(!icon && "border-dashed text-muted-foreground")}
              />} />
            }
          >
            {icon ? <LucideIcon name={icon} className={named ? "text-primary" : undefined} /> : <SmilePlusIcon aria-hidden />}
            {named && (
              <>
                <span className="capitalize">{icon?.replaceAll("-", " ") ?? "No icon"}</span>
                <span className="ml-3 text-muted-foreground">Change</span>
              </>
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
            {/* Taking it off is part of picking. */}
            {value && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-1 w-full"
                onClick={() => {
                  setIcon(null);
                  setOpen(false);
                }}
              >
                Remove icon
              </Button>
            )}
          </PopoverContent>
        </Popover><TooltipContent>{icon ? "Change icon" : "Add icon"}</TooltipContent></Tooltip>
      </div>
    );
  }
  return (
    <Field>
      <input type="hidden" name="icon" value={value ?? ""} />
      <div className="flex flex-wrap gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={<Button type="button" variant="outline" size="sm" aria-label={icon ? named ? `${icon.replaceAll("-", " ")} Change icon` : `Change icon (${icon.replaceAll("-", " ")})` : undefined} />}
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
        {value && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setIcon(null)}>
            Remove icon
          </Button>
        )}
      </div>
    </Field>
  );
}
