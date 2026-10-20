import { isIP } from "node:net";

/**
 * What counts as one visitor for per-visitor limits: an IPv4 address as it is, an
 * IPv6 address as its /64 (one host usually gets a whole /64, so it could rotate
 * through it), an IPv4-mapped IPv6 address as its IPv4 address. Null for anything
 * that isn't an IP address.
 */
export function clientKey(ip: string): string | null {
  const address = ip.trim().split("%")[0]!.toLowerCase(); // without a zone id (fe80::1%eth0)
  const version = isIP(address);
  if (version === 4) {
    return address;
  }
  if (version !== 6) {
    return null;
  }
  // A dotted IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) is the last two groups.
  const hex = address.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_, a, b, c, d) =>
    [(Number(a) << 8) | Number(b), (Number(c) << 8) | Number(d)].map((n) => n.toString(16)).join(":"),
  );
  const [head, tail] = hex.split("::") as [string, string | undefined];
  const split = (part: string | undefined) => (part ? part.split(":") : []);
  const groups =
    tail === undefined
      ? split(head)
      : [...split(head), ...Array<string>(8 - split(head).length - split(tail).length).fill("0"), ...split(tail)];
  const [a, b, c, d, e, f, g, h] = groups.map((group) => parseInt(group, 16));
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return [g! >> 8, g! & 0xff, h! >> 8, h! & 0xff].join(".");
  }
  return `${[a, b, c, d].map((n) => n!.toString(16)).join(":")}::/64`;
}
