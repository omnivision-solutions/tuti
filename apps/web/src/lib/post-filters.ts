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

/** What a portal board lists unless asked for a status, or for all of them: the ideas not done yet. */
export const ACTIVE_STATUSES: PostStatus[] = ["OPEN", "UNDER_REVIEW", "PLANNED", "IN_PROGRESS"];

/** The statuses a portal board lists: the one asked for, every one with `?status=all`, else the active ones. */
export function boardStatuses(searchParams: Record<string, string | string[] | undefined>): PostStatus[] | undefined {
  const { status } = parsePostFilters(searchParams);
  return status ? [status] : first(searchParams.status) === "all" ? undefined : ACTIVE_STATUSES;
}

export const SORTS = { top: "Most votes", new: "Newest" } as const;
/** The team's Feedback also sorts by Trending: votes in the last 7 days. */
export const TEAM_SORTS = { ...SORTS, trending: "Trending" } as const;
export type Sort = keyof typeof TEAM_SORTS;

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
    sort: (sortParam === "new" || sortParam === "trending" ? sortParam : "top") as Sort,
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

/** Trending orders by a count Prisma can't (see teamPosts); elsewhere it's Most votes. */
export function postOrderBy(sort: Sort): Prisma.PostOrderByWithRelationInput[] {
  // `id` last: posts created together keep one order, so pages neither repeat nor skip them.
  return sort === "new"
    ? [{ createdAt: "desc" }, { id: "desc" }]
    : [{ voteCount: "desc" }, { createdAt: "desc" }, { id: "desc" }];
}
