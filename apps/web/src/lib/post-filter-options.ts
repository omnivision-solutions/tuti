import { STATUS_LABELS } from "@/components/post-status-badge";

import type { Filter } from "@/components/list-filters";

import { SORTS, STATUS_PARAMS } from "./post-filters";

export function sortFilter(value: string): Filter {
  return { name: "sort", label: "Sort", value, options: Object.entries(SORTS).map(([v, label]) => ({ value: v, label })) };
}

export function statusFilter(value: string): Filter {
  return {
    name: "status",
    label: "Status",
    value,
    options: [
      { value: "all", label: "All statuses" },
      ...Object.entries(STATUS_PARAMS).map(([v, status]) => ({ value: v, label: STATUS_LABELS[status] })),
    ],
  };
}
