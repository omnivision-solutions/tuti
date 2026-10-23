"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type Filter = {
  /** Query parameter, e.g. "status". */
  name: string;
  label: string;
  value: string;
  /** The first option is the default and is left out of the URL. */
  options: { value: string; label: string }[];
};

/** Filter/sort controls for post lists, kept in the URL so views can be shared. */
export function ListFilters({ filters }: { filters: Filter[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const update = (filter: Filter, value: string) => {
    const params = new URLSearchParams(searchParams);
    // Other filters, other pages: start from the first.
    params.delete("page");
    if (value === filter.options[0]?.value) {
      params.delete(filter.name);
    } else {
      params.set(filter.name, value);
    }
    const query = params.toString();
    startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }));
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-pending={pending || undefined}>
      {filters.map((filter) => (
        <Select
          key={filter.name}
          items={Object.fromEntries(filter.options.map((o) => [o.value, o.label]))}
          value={filter.value}
          onValueChange={(value) => update(filter, String(value))}
        >
          <SelectTrigger size="sm" aria-label={filter.label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {filter.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ))}
    </div>
  );
}
