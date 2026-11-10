/** How the app names a conversation's statuses (the API's spelling as keys). */
export const CONVERSATION_STATUS_LABELS = { open: "Open", waiting: "Waiting on user", closed: "Closed" } as const;
export type ConversationStatusName = keyof typeof CONVERSATION_STATUS_LABELS;

/** Only a conversation needing the team uses the attention colour. */
export const CONVERSATION_STATUS_STYLES = {
  OPEN: { pill: "bg-highlight text-highlight-foreground", dot: "bg-highlight-foreground" },
  WAITING: { pill: "bg-status-open/10 text-foreground", dot: "bg-status-open" },
  CLOSED: { pill: "bg-status-closed/10 text-foreground", dot: "bg-status-closed" },
} as const;
