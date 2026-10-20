/**
 * Portal readers can be a whole domain ("@acme.com"): everyone with a verified address there. Not a
 * domain anyone can get an address at, which would open the portal to everyone.
 */

export const DOMAIN_ENTRY = /^@(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Free email providers: anyone can sign up there. */
export const OPEN_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "web.de",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "mail.ru",
  "qq.com",
  "163.com",
  "126.com",
  "tutanota.com",
  "tuta.io",
  "fastmail.com",
  "hey.com",
]);

/** The reader entries an address matches: itself, and its domain's. */
export function readerEntriesFor(email: string): string[] {
  const address = email.toLowerCase();
  return [address, address.slice(address.lastIndexOf("@"))];
}
