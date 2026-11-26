/**
 * The messages Try again re-queues (conversations.retryTranslation), of those on the page: the customer's (not notes)
 * whose translation failed and that have none. Each says "Translating…" once it's queued again.
 */
export const retriedByTryAgain = (messages: { id: string; author: string; note: boolean; teamText: string | null; translationError: string | null }[]) =>
  messages.filter((m) => m.author === "USER" && !m.note && m.teamText === null && m.translationError !== null).map((m) => m.id);
