import {
  getAiFirst,
  updateAiFirst,
} from "./ai-first";
import { getAiModelSetting } from "./ai-model-setting";
import {
  getAiModels,
  updateAiModels,
} from "./ai-models";
import {
  createApiReference,
  deleteApiReference,
  getApiReference,
  listApiReferences,
  replaceApiReference,
  syncApiReference,
  updateApiReference,
} from "./api-references";
import {
  getAssistantSettings,
  updateAssistantSettings,
} from "./assistant";
import {
  getBranding,
  updateBranding,
} from "./branding";
import {
  addChangelogPullRequests,
  composeChangelogCover,
  createChangelogEntry,
  deleteChangelogEntry,
  draftChangelogEntry,
  editChangelogSection,
  getChangelogEntry,
  getChangelogStyle,
  getChangelogStyleSettings,
  listChangelog,
  listMissingChanges,
  publishChangelogEntry,
  reactToChangelogEntry,
  removeChangelogPullRequest,
  unpublishChangelogEntry,
  updateChangelogEntry,
  updateChangelogStyle,
} from "./changelog";
import {
  createChangelogComment,
  deleteChangelogComment,
  listChangelogComments,
  updateChangelogComment,
} from "./changelog-comments";
import { markChangelogSeen } from "./changelog-seen";
import {
  addChangelogSubscribers,
  listChangelogSubscribers,
  removeChangelogSubscribers,
} from "./changelog-subscribers";
import {
  getChangelogTranslation,
  saveChangelogTranslation,
} from "./changelog-translations";
import { getCodeChangeButton } from "./code-change-button";
import {
  analyseCodeChange,
  applyCodeChangeAction,
  applyCodeChangeActions,
  dismissCodeChangeAction,
  getCodeChange,
  getCodeChangeTarget,
  listCodeChangeTargets,
  listCodeChanges,
  publishCodeChangeActionNow,
  resumeCodeChanges,
  stopCodeChangeAction,
  undoCodeChangeAction,
} from "./code-changes";
import {
  getCodeChangesTuning,
  updateCodeChangesTuning,
} from "./code-changes-tuning";
import { getConversationActivity } from "./conversation-activity";
import { getConversationPerson } from "./conversation-person";
import {
  createConversation,
  getConversation,
  linkConversationPost,
  listArticlesToInsert,
  listAssignees,
  listConversations,
  listInboxViews,
  markConversationRead,
  replyToConversation,
  retryTranslation,
  startReplyUpload,
  translateReply,
  unlinkConversationPost,
  updateConversation,
} from "./conversations";
import {
  getChangelogCover,
  getChangelogStyleCover,
} from "./covers";
import {
  createComment,
  createPost,
} from "./create";
import {
  getCredits,
  topUpCredits,
} from "./credits";
import { getPortalPreview } from "./customize";
import type {
  Operation,
  PublicOperation,
} from "./define";
import {
  getNotificationSettings,
  registerDevice,
  removeDevice,
  updateNotificationSettings,
} from "./devices";
import {
  createArticle,
  createCollection,
  createTab,
  deleteArticle,
  deleteCollection,
  deleteTab,
  discardChanges,
  getArticle,
  listArticles,
  listCollections,
  listRevisions,
  listTabs,
  publishArticle,
  publishChanges,
  reorderArticle,
  reorderCollection,
  reorderTab,
  restoreArticle,
  searchArticles,
  setArticleLanguageSlug,
  unpublishArticle,
  updateArticle,
  updateCollection,
  updateTab,
} from "./docs";
import { askDocs } from "./docs-ask";
import { escalateDocs } from "./docs-escalate";
import {
  answerArticle,
  dismissDocsGap,
  getDocsInsights,
} from "./docs-insights";
import {
  getDomain,
  removeDomain,
  setDomain,
  verifyDomain,
} from "./domain";
import { updateEmailPreferences } from "./email-preferences";
import { listGithubRepositories } from "./github";
import {
  finishGithubConnect,
  getGithubConnect,
} from "./github-connect";
import {
  getGlossary,
  updateGlossary,
} from "./glossary";
import {
  createGroup,
  deleteGroup,
  getAskingSettings,
  getGroupsSettings,
  listGroups,
  previewGroup,
  suggestGroupValues,
  updateGroup,
} from "./groups";
import { generateImageOperation } from "./images";
import {
  getImport,
  startImport,
} from "./imports";
import {
  findPostsToLink,
  getConversationLanguage,
  getInboxList,
  setNewConversationEmails,
} from "./inbox";
import { getInboxConversation } from "./inbox-conversation";
import {
  getBoardTranslations,
  getCollectionTranslations,
  getTabTranslations,
  updateBoardTranslation,
  updateCollectionTranslation,
  updateTabTranslation,
} from "./label-translations";
import {
  getLanguages,
  retranslateLanguage,
  updateLanguages,
} from "./languages";
import { checkLicense } from "./license";
import { removeLink } from "./links";
import { getInboxLive } from "./live";
import {
  mergePost,
  updatePost,
} from "./manage";
import {
  dismissDuplicate,
  getPortalAccess,
  getProject,
  getSettingsAccess,
  likeComment,
  listDuplicates,
  listTeam,
  setSubscription,
  setVote,
  updateProject,
  updatePropertyFormats,
} from "./more";
import {
  getPlan,
  managePlan,
  setBadgeAddOn,
  subscribePlan,
} from "./plan";
import {
  addPortalReaders,
  getAccessSettings,
  getPortal,
  listPortalReaders,
  removePortalReader,
  updatePortal,
} from "./portal";
import {
  getPost,
  getRoadmap,
  listBoards,
  listComments,
  listPosts,
} from "./read";
import {
  createRedirect,
  deleteRedirect,
  listRedirects,
} from "./redirects";
import { getReports } from "./reports";
import {
  getArticleScreenshotsStatus,
  getEntryScreenshotsStatus,
} from "./screenshot-status";
import {
  getScreenshotSettings,
  getScreenshotSignInDomains,
  getScreenshots,
  scanScreenshotSignInDomains,
  takeArticleScreenshots,
  takeChangelogScreenshots,
  takeScreenshots,
  testScreenshotSettings,
  updateScreenshotSettings,
} from "./screenshots";
import { similarPosts } from "./similar-posts";
import {
  getSite,
  removeSite,
  setSite,
  verifySite,
} from "./site";
import {
  getSpamSettings,
  trySpamFilter,
  updateSpamSettings,
} from "./spam";
import {
  disableSso,
  getSso,
  rotateSsoSecret,
  updateSso,
} from "./sso";
import {
  checkEmailDomainOperation,
  getSupportSettings,
  removeEmailDomain,
  setEmailDomain,
  updateSupportSettings,
} from "./support";
import {
  suggestReply,
  summarizeConversation,
} from "./support-ai";
import {
  getTranslation,
  keepTranslationUpToDate,
  publishTranslation,
  saveTranslation,
  updateTranslationSections,
} from "./translations";
import {
  createUpload,
  finishUpload,
  getUploadStatus,
} from "./uploads";
import { getUsage } from "./usage";
import {
  deleteUser,
  getUser,
  listCompanies,
  listUsers,
  syncUsersOperation,
} from "./users";
import {
  listVerifications,
  verifyAll,
  verifyArticle,
} from "./verify";
import {
  getWidgetSettings,
  updateWidgetSettings,
} from "./widget";
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  moveWorkflow,
  updateWorkflow,
} from "./workflows";
export { type Actor, type ApiKeyActor, type Operation, OperationError, type PublicOperation } from "./define";

/**
 * Every operation, as a list of literal types: the tRPC router is typed from it.
 * Not sorted: its order is the API docs', the OpenAPI document's and MCP's tool list's, and `matchOperation` takes the first
 * path that fits. Add an operation beside its group's, not at the end.
 */
export const all = [
  getProject,
  getSettingsAccess,
  getPortalAccess,
  updateProject,
  updatePropertyFormats,
  listTeam,
  listInboxViews,
  getInboxList,
  getConversationLanguage,
  setNewConversationEmails,
  getGithubConnect,
  finishGithubConnect,
  getInboxLive,
  getCodeChangeButton,
  getChangelogCover,
  getChangelogStyleCover,
  getEntryScreenshotsStatus,
  getArticleScreenshotsStatus,
  listAssignees,
  listConversations,
  markConversationRead,
  startReplyUpload,
  registerDevice,
  removeDevice,
  getNotificationSettings,
  updateNotificationSettings,
  listArticlesToInsert,
  getConversation,
  getInboxConversation,
  getConversationPerson,
  findPostsToLink,
  getConversationActivity,
  createConversation,
  replyToConversation,
  translateReply,
  retryTranslation,
  updateConversation,
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  moveWorkflow,
  deleteWorkflow,
  linkConversationPost,
  unlinkConversationPost,
  suggestReply,
  summarizeConversation,
  getSpamSettings,
  updateSpamSettings,
  getAiFirst,
  updateAiFirst,
  trySpamFilter,
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
  listChangelogComments,
  createChangelogComment,
  updateChangelogComment,
  deleteChangelogComment,
  markChangelogSeen,
  createChangelogEntry,
  updateChangelogEntry,
  editChangelogSection,
  getChangelogTranslation,
  saveChangelogTranslation,
  composeChangelogCover,
  generateImageOperation,
  listMissingChanges,
  addChangelogPullRequests,
  removeChangelogPullRequest,
  draftChangelogEntry,
  publishChangelogEntry,
  unpublishChangelogEntry,
  deleteChangelogEntry,
  getChangelogStyle,
  getChangelogStyleSettings,
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
  getReports,
  createArticle,
  updateArticle,
  publishArticle,
  setArticleLanguageSlug,
  getTranslation,
  saveTranslation,
  publishTranslation,
  updateTranslationSections,
  keepTranslationUpToDate,
  publishChanges,
  discardChanges,
  unpublishArticle,
  deleteArticle,
  listRevisions,
  restoreArticle,
  verifyArticle,
  listVerifications,
  verifyAll,
  startImport,
  getImport,
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
  listApiReferences,
  getApiReference,
  createApiReference,
  updateApiReference,
  replaceApiReference,
  syncApiReference,
  deleteApiReference,
  listGithubRepositories,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  getAskingSettings,
  getGroupsSettings,
  previewGroup,
  suggestGroupValues,
  listUsers,
  listCompanies,
  getUser,
  syncUsersOperation,
  deleteUser,
  listPosts,
  getPost,
  similarPosts,
  listComments,
  createPost,
  createComment,
  updatePost,
  mergePost,
  removeLink,
  listCodeChanges,
  getCodeChange,
  listCodeChangeTargets,
  getCodeChangeTarget,
  analyseCodeChange,
  resumeCodeChanges,
  applyCodeChangeAction,
  applyCodeChangeActions,
  undoCodeChangeAction,
  publishCodeChangeActionNow,
  stopCodeChangeAction,
  dismissCodeChangeAction,
  setVote,
  likeComment,
  setSubscription,
  updateEmailPreferences,
  listChangelogSubscribers,
  addChangelogSubscribers,
  removeChangelogSubscribers,
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
  getCodeChangesTuning,
  updateCodeChangesTuning,
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
  getAccessSettings,
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
  getLanguages,
  updateLanguages,
  retranslateLanguage,
  getGlossary,
  updateGlossary,
  getCollectionTranslations,
  updateCollectionTranslation,
  getTabTranslations,
  updateTabTranslation,
  getBoardTranslations,
  updateBoardTranslation,
  getPortalPreview,
  // Before screenshots.get: /screenshots/settings isn't a run's id.
  getAiModelSetting,
  getScreenshotSettings,
  updateScreenshotSettings,
  testScreenshotSettings,
  getScreenshotSignInDomains,
  scanScreenshotSignInDomains,
  takeScreenshots,
  getScreenshots,
  takeChangelogScreenshots,
  takeArticleScreenshots,
  createUpload,
  finishUpload,
  getUploadStatus,
  getSso,
  rotateSsoSecret,
  disableSso,
  updateSso,
] as const;

/** Every operation, each a tRPC procedure (server/trpc/router.ts). */
export const allOperations: readonly Operation[] = all;

/** The public API's operations, served in REST, MCP and the docs: all but the `internal` ones. */
export const operations: PublicOperation[] = allOperations.filter((operation): operation is PublicOperation => !operation.internal);

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
