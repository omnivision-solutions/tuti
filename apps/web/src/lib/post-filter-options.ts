import type { Filter } from "@/components/list-filters";

import { SORTS } from "./post-filters";

export function sortFilter(value: string, sorts: Record<string, string> = SORTS): Filter {
  return { name: "sort", label: "Sort", value, options: Object.entries(sorts).map(([v, label]) => ({ value: v, label })) };
}
