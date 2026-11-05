"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type CollectionItem = { value: string | null; label: string };

/** The collection picker (an article's in Docs, a new article's draft's in Autopilot): `items` by value (a collection's slug; null for none). */
export function CollectionSelect({
  items,
  value,
  onChange,
  labelledBy,
  describedBy,
  disabled,
  className = "w-full",
}: {
  items: CollectionItem[];
  value: string | null;
  onChange: (value: string | null) => void;
  labelledBy: string;
  describedBy?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select items={items} value={value} disabled={disabled} onValueChange={(next) => onChange(next as string | null)}>
      <SelectTrigger className={className} aria-labelledby={labelledBy} aria-describedby={describedBy}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value ?? ""} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
