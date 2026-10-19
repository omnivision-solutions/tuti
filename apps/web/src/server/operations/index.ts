import type { Operation } from "./define";
import { createComment, createPost } from "./create";
import { acceptLinkSuggestion, addLink, dismissLinkSuggestion, listLinkSuggestions, removeLink } from "./links";
import { mergePost, updatePost } from "./manage";
import { dismissDuplicate, getProject, listDuplicates, listTeam, setVote } from "./more";
import {
  createChangelogEntry,
  deleteChangelogEntry,
  draftChangelogEntry,
  getChangelogEntry,
  getChangelogStyle,
  listChangelog,
  publishChangelogEntry,
  unpublishChangelogEntry,
  updateChangelogEntry,
  updateChangelogStyle,
} from "./changelog";
import {
  createArticle,
  createCollection,
  deleteArticle,
  deleteCollection,
  getArticle,
  listArticles,
  listCollections,
  publishArticle,
  unpublishArticle,
  updateArticle,
  updateCollection,
} from "./help";
import { getPost, getRoadmap, listBoards, listComments, listPosts } from "./read";

export { type Actor, type ApiKeyActor, type Operation, OperationError } from "./define";

const all = [
  getProject,
  listTeam,
  listBoards,
  getRoadmap,
  listChangelog,
  getChangelogEntry,
  createChangelogEntry,
  updateChangelogEntry,
  draftChangelogEntry,
  publishChangelogEntry,
  unpublishChangelogEntry,
  deleteChangelogEntry,
  getChangelogStyle,
  updateChangelogStyle,
  listArticles,
  getArticle,
  createArticle,
  updateArticle,
  publishArticle,
  unpublishArticle,
  deleteArticle,
  listCollections,
  createCollection,
  updateCollection,
  deleteCollection,
  listPosts,
  getPost,
  listComments,
  createPost,
  createComment,
  updatePost,
  mergePost,
  addLink,
  removeLink,
  listLinkSuggestions,
  acceptLinkSuggestion,
  dismissLinkSuggestion,
  setVote,
  listDuplicates,
  dismissDuplicate,
] as const;

/** Every operation, served in the app, the REST API and MCP. */
export const operations: Operation[] = all as unknown as Operation[];

/** Every operation's name, e.g. "posts.list". */
export type OperationName = (typeof all)[number]["name"];

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
