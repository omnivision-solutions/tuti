import { STATUS_LABELS } from "@/components/post-status-badge";

import type { Filter } from "@/components/list-filters";

import { boardStatuses, parsePostFilters, SORTS, STATUS_PARAMS } from "./post-filters";

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

/** A portal board's status filter: the ideas not done yet first (the default), each status, then all of them. */
export function boardStatusFilter(searchParams: Record<string, string | string[] | undefined>): Filter {
  const statuses = boardStatuses(searchParams);
  return {
    name: "status",
    label: "Status",
    value: !statuses ? "all" : statuses.length === 1 ? parsePostFilters(searchParams).statusParam : "active",
    options: [
      { value: "active", label: "Not done yet" },
      ...Object.entries(STATUS_PARAMS).map(([v, status]) => ({ value: v, label: STATUS_LABELS[status] })),
      { value: "all", label: "All statuses" },
    ],
  };
}
