import type { PostStatus, Prisma } from "@tuti/db";

/** URL query values for post lists (?status=planned&sort=new&board=bugs). */
export const STATUS_PARAMS: Record<string, PostStatus> = {
  open: "OPEN",
  "under-review": "UNDER_REVIEW",
  planned: "PLANNED",
  "in-progress": "IN_PROGRESS",
  completed: "COMPLETED",
  closed: "CLOSED",
};

export const SORTS = { top: "Most votes", new: "Newest" } as const;
export type Sort = keyof typeof SORTS;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parsePostFilters(searchParams: Record<string, string | string[] | undefined>) {
  const statusParam = first(searchParams.status);
  const sortParam = first(searchParams.sort);
  return {
    statusParam: statusParam && statusParam in STATUS_PARAMS ? statusParam : "all",
    status: statusParam ? STATUS_PARAMS[statusParam] : undefined,
    sort: (sortParam === "new" ? "new" : "top") as Sort,
    board: first(searchParams.board),
  };
}

export function postOrderBy(sort: Sort): Prisma.PostOrderByWithRelationInput[] {
  return sort === "new" ? [{ createdAt: "desc" }] : [{ voteCount: "desc" }, { createdAt: "desc" }];
}
