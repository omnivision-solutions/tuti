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

/** Lists show this many posts, and this many more with each "Load more" (`?page=`). */
export const POSTS_PER_PAGE = 50;

export const SORTS = { top: "Most votes", new: "Newest" } as const;
export type Sort = keyof typeof SORTS;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parsePostFilters(searchParams: Record<string, string | string[] | undefined>) {
  const param = first(searchParams.status);
  const statusParam = param && Object.hasOwn(STATUS_PARAMS, param) ? param : undefined;
  const sortParam = first(searchParams.sort);
  const page = Number(first(searchParams.page));
  return {
    statusParam: statusParam ?? "all",
    status: statusParam ? STATUS_PARAMS[statusParam] : undefined,
    sort: (sortParam === "new" ? "new" : "top") as Sort,
    board: first(searchParams.board),
    /** How many pages are shown: a list grows by a page each "Load more", from the first. */
    page: Number.isSafeInteger(page) && page > 1 ? page : 1,
  };
}

export type PostFilters = ReturnType<typeof parsePostFilters>;

/** The same list, one page longer. */
export function nextPageHref(searchParams: Record<string, string | string[] | undefined>, filters: PostFilters) {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(searchParams)) {
    for (const one of [value ?? []].flat()) {
      params.append(name, one);
    }
  }
  params.set("page", String(filters.page + 1));
  return `?${params}`;
}

export function postOrderBy(sort: Sort): Prisma.PostOrderByWithRelationInput[] {
  // `id` last: posts created together keep one order, so pages neither repeat nor skip them.
  return sort === "new"
    ? [{ createdAt: "desc" }, { id: "desc" }]
    : [{ voteCount: "desc" }, { createdAt: "desc" }, { id: "desc" }];
}
