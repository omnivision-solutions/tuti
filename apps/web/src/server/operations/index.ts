import type { Operation } from "./define";
import { getBranding, updateBranding } from "./branding";
import { checkLicense } from "./license";
import { analyseCodeChange, applyCodeChangeAction, applyCodeChangeActions, dismissCodeChangeAction, publishCodeChangeActionNow, stopCodeChangeAction, undoCodeChangeAction, getCodeChange, listCodeChanges, resumeCodeChanges } from "./code-changes";
import { createComment, createPost } from "./create";
import {
  createConversation,
  getConversation,
  linkConversationPost,
  listConversations,
  replyToConversation,
  unlinkConversationPost,
  updateConversation,
} from "./conversations";
import { checkEmailDomainOperation, getSupportSettings, removeEmailDomain, setEmailDomain, updateSupportSettings } from "./support";
import { suggestReply, summarizeConversation } from "./support-ai";
import { removeLink } from "./links";
import { mergePost, updatePost } from "./manage";
import { dismissDuplicate, getProject, listDuplicates, listTeam, setSubscription, setVote, updateProject, updatePropertyFormats } from "./more";
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
  createTab,
  deleteTab,
  listTabs,
  reorderTab,
  updateTab,
} from "./docs";
import { markChangelogSeen } from "./changelog-seen";
import { getAssistantSettings, updateAssistantSettings } from "./assistant";
import { askDocs } from "./docs-ask";
import { escalateDocs } from "./docs-escalate";
import { answerArticle, dismissDocsGap, getDocsInsights } from "./docs-insights";
import { createGroup, deleteGroup, listGroups, updateGroup } from "./groups";
import { getUser, listCompanies, listUsers, syncUsersOperation } from "./users";
import { addPortalReaders, getPortal, listPortalReaders, removePortalReader, updatePortal } from "./portal";
import { getDomain, removeDomain, setDomain, verifyDomain } from "./domain";
import { getSite, removeSite, setSite, verifySite } from "./site";
import { createRedirect, deleteRedirect, listRedirects } from "./redirects";
import { getPost, getRoadmap, listBoards, listComments, listPosts } from "./read";
import { getUsage } from "./usage";
import { getAiModels, updateAiModels } from "./ai-models";
import { getCredits, topUpCredits } from "./credits";
import { getPlan, managePlan, setBadgeAddOn, subscribePlan } from "./plan";
import { getWidgetSettings, updateWidgetSettings } from "./widget";

export { type Actor, type ApiKeyActor, type Operation, OperationError } from "./define";

const all = [
  getProject,
  updateProject,
  updatePropertyFormats,
  listTeam,
  listConversations,
  getConversation,
  createConversation,
  replyToConversation,
  updateConversation,
  linkConversationPost,
  unlinkConversationPost,
  suggestReply,
  summarizeConversation,
  getSupportSettings,
  updateSupportSettings,
  setEmailDomain,
  checkEmailDomainOperation,
  removeEmailDomain,
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
  askDocs,
  escalateDocs,
  getAssistantSettings,
  updateAssistantSettings,
  getDocsInsights,
  dismissDocsGap,
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
  listTabs,
  createTab,
  updateTab,
  reorderTab,
  deleteTab,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  listUsers,
  listCompanies,
  getUser,
  syncUsersOperation,
  listPosts,
  getPost,
  listComments,
  createPost,
  createComment,
  updatePost,
  mergePost,
  removeLink,
  listCodeChanges,
  getCodeChange,
  analyseCodeChange,
  resumeCodeChanges,
  applyCodeChangeAction,
  applyCodeChangeActions,
  undoCodeChangeAction,
  publishCodeChangeActionNow,
  stopCodeChangeAction,
  dismissCodeChangeAction,
  setVote,
  setSubscription,
  listDuplicates,
  dismissDuplicate,
  getWidgetSettings,
  updateWidgetSettings,
  getBranding,
  updateBranding,
  checkLicense,
  getUsage,
  getAiModels,
  updateAiModels,
  getCredits,
  topUpCredits,
  getPlan,
  subscribePlan,
  managePlan,
  setBadgeAddOn,
  getPortal,
  updatePortal,
  listPortalReaders,
  addPortalReaders,
  removePortalReader,
  getDomain,
  setDomain,
  verifyDomain,
  removeDomain,
  getSite,
  setSite,
  verifySite,
  removeSite,
  listRedirects,
  createRedirect,
  deleteRedirect,
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
