/** A From line as its name and address: "Kim Lee <kim@acme.example>", or a bare address as itself (Settings → Spam's Try a message). */
export function parseFrom(from: string): { name: string; sender: string } {
  const named = /^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/.exec(from);
  return named ? { name: named[1]!.trim(), sender: named[2]!.trim() } : { name: "", sender: from.trim() };
}
