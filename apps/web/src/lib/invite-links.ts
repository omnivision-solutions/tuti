/** An invite's link to pass on by hand (a server without email), with the address it's for. */
export type InviteLink = { email: string; url: string };

/**
 * The links Team & roles shows to copy, with a send's new ones added: every one stays till the page is left (each is
 * shown this once, and its invite is live), a newer link for an address taking its older one's place; a send that
 * brought none (it failed, or email went out) leaves them as they are.
 */
export function keepLinks(shown: InviteLink[], added: InviteLink[] | undefined): InviteLink[] {
  if (!added?.length) {
    return shown;
  }
  const emails = new Set(added.map((link) => link.email));
  return [...shown.filter((link) => !emails.has(link.email)), ...added];
}

/** Where focus goes after a row's Send or Remove (`done`; null: Send all): the next row's, else none (the card's heading, or the pending list). */
export function nextRow(ids: string[], done: string | null): string | null {
  if (done === null) {
    return null;
  }
  const at = ids.indexOf(done);
  return ids[at + 1] ?? null;
}
