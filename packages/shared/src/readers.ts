/** The portal reader entries an address matches (entries are kept lowercase): itself, and its domain's ("@acme.com"). */
export function readerEntriesFor(email: string): string[] {
  const address = email.toLowerCase();
  return [address, address.slice(address.lastIndexOf("@"))];
}
