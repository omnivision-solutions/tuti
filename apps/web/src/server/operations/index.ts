import type { Operation } from "./define";
import { createComment, createPost } from "./create";
import { addLink, removeLink } from "./links";
import { mergePost, updatePost } from "./manage";
import { getPost, listBoards, listComments, listPosts } from "./read";

export { type Actor, type ApiKeyActor, type Operation, OperationError } from "./define";

/** Every operation the API serves. */
export const operations: Operation[] = [
  listBoards,
  listPosts,
  getPost,
  listComments,
  createPost,
  createComment,
  updatePost,
  mergePost,
  addLink,
  removeLink,
] as Operation[];

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

/** MCP tool names allow letters, digits, _ and -: posts.list → posts_list. */
export const toolName = (operation: Operation) => operation.name.replace(".", "_");
