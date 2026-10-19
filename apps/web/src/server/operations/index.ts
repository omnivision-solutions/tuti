import type { Operation } from "./define";
import { getPost, listBoards, listComments, listPosts } from "./read";

export { type Actor, type Operation, OperationError } from "./define";

/** Every operation the API serves. */
export const operations: Operation[] = [listBoards, listPosts, getPost, listComments] as Operation[];

/** The operation for a request, with the values from its path (e.g. {number}). */
export function matchOperation(method: string, path: string) {
  for (const operation of operations) {
    if (operation.method !== method) {
      continue;
    }
    const names: string[] = [];
    const pattern = operation.path.replace(/\{(\w+)\}/g, (_, name: string) => {
      names.push(name);
      return "([^/]+)";
    });
    const match = new RegExp(`^${pattern}$`).exec(path);
    if (match) {
      return { operation, params: Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(match[i + 1]!)])) };
    }
  }
  return null;
}
