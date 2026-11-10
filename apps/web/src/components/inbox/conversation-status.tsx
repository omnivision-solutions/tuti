import type { ConversationStatus } from "@tuti/db";
import { CONVERSATION_STATUS_LABELS, CONVERSATION_STATUS_STYLES, type ConversationStatusName } from "@/lib/conversation-statuses";
import { cn } from "@/lib/utils";

/** The same dot-and-text status in the person's activity and the Inbox's context. */
export function ConversationStatusText({ status }: { status: ConversationStatus }) {
  return <span className="inline-flex items-center gap-1.25"><span aria-hidden className={cn("size-1.5 rounded-full", CONVERSATION_STATUS_STYLES[status].dot)} />{CONVERSATION_STATUS_LABELS[status.toLowerCase() as ConversationStatusName]}</span>;
}
