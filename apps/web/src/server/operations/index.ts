import type { Operation } from "./define";
import { getBranding, updateBranding } from "./branding";
import { createComment, createPost } from "./create";
import { acceptLinkSuggestion, addLink, dismissLinkSuggestion, listLinkSuggestions, removeLink } from "./links";
import { mergePost, updatePost } from "./manage";
import { dismissDuplicate, getProject, listDuplicates, listTeam, setVote } from "./more";
import {
  createChangelogEntry,
  deleteChangelogEntry,
  draftChangelogEntry,
  rewriteChangelogEntry,
  getChangelogEntry,
  getChangelogStyle,
  listChangelog,
  publishChangelogEntry,
  reactToChangelogEntry,
  unpublishChangelogEntry,
  updateChangelogEntry,
  updateChangelogStyle,
} from "./changelog";
import {
  createArticle,
  createCollection,
  deleteArticle,
  discardChanges,
  listRevisions,
  publishChanges,
  reorderArticle,
  reorderCollection,
  restoreArticle,
  deleteCollection,
  getArticle,
  listArticles,
  listCollections,
  publishArticle,
  searchArticles,
  unpublishArticle,
  updateArticle,
  updateCollection,
  createSection,
  deleteSection,
  listSections,
  reorderSection,
  updateSection,
} from "./help";
import { markChangelogSeen } from "./changelog-seen";
import { getAssistantSettings, updateAssistantSettings } from "./assistant";
import { askHelp } from "./help-ask";
import { escalateHelp } from "./help-escalate";
import { answerArticle, dismissHelpGap, getHelpInsights } from "./help-insights";
import { addPortalReaders, getPortal, listPortalReaders, removePortalReader, updatePortal } from "./portal";
import { getDomain, removeDomain, setDomain, verifyDomain } from "./domain";
import { getPost, getRoadmap, listBoards, listComments, listPosts } from "./read";
import { getWidgetSettings, updateWidgetSettings } from "./widget";

export { type Actor, type ApiKeyActor, type Operation, OperationError } from "./define";

const all = [
  getProject,
  listTeam,
  listBoards,
  getRoadmap,
  listChangelog,
  getChangelogEntry,
  reactToChangelogEntry,
  markChangelogSeen,
  createChangelogEntry,
  updateChangelogEntry,
  draftChangelogEntry,
  rewriteChangelogEntry,
  publishChangelogEntry,
  unpublishChangelogEntry,
  deleteChangelogEntry,
  getChangelogStyle,
  updateChangelogStyle,
  listArticles,
  getArticle,
  searchArticles,
  answerArticle,
  askHelp,
  escalateHelp,
  getAssistantSettings,
  updateAssistantSettings,
  getHelpInsights,
  dismissHelpGap,
  createArticle,
  updateArticle,
  publishArticle,
  publishChanges,
  discardChanges,
  unpublishArticle,
  deleteArticle,
  listRevisions,
  restoreArticle,
  reorderArticle,
  listCollections,
  createCollection,
  updateCollection,
  reorderCollection,
  deleteCollection,
  listSections,
  createSection,
  updateSection,
  reorderSection,
  deleteSection,
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
  getWidgetSettings,
  updateWidgetSettings,
  getBranding,
  updateBranding,
  getPortal,
  updatePortal,
  listPortalReaders,
  addPortalReaders,
  removePortalReader,
  getDomain,
  setDomain,
  verifyDomain,
  removeDomain,
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
