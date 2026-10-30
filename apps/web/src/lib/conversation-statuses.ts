/** How the app names a conversation's statuses (the API's spelling as keys). */
export const CONVERSATION_STATUS_LABELS = { open: "Open", waiting: "Waiting on user", closed: "Closed" } as const;
export type ConversationStatusName = keyof typeof CONVERSATION_STATUS_LABELS;
