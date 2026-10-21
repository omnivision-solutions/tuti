/** Docs collections go in other collections, this many levels deep at most (the top level is 1). */
export const MAX_COLLECTION_DEPTH = 5;

type Node = { id: string; parentId: string | null };

/** Collection `id` and the ones it's in, from it up to its top-level one (empty if it isn't in `rows`). */
export function ancestry<T extends Node>(rows: T[], id: string | null): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const chain: T[] = [];
  // At most every row once, should the rows ever loop.
  for (let row = id === null ? undefined : byId.get(id); row && chain.length < rows.length; row = row.parentId === null ? undefined : byId.get(row.parentId)) {
    chain.push(row);
  }
  return chain;
}

/** How many levels collection `id` and the ones in it take: 1 with none in it. */
export function height(rows: Node[], id: string): number {
  return 1 + Math.max(0, ...rows.filter((row) => row.parentId === id).map((row) => height(rows, row.id)));
}
