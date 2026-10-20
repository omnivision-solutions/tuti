import { expect, test } from "vitest";

import { clientKey } from "./client-ip";

test.each([
  // IPv4 as it is.
  ["203.0.113.7", "203.0.113.7"],
  [" 203.0.113.7 ", "203.0.113.7"],
  // IPv6: its /64, however it's written.
  ["2001:0db8:0000:0042:0000:8a2e:0370:7334", "2001:db8:0:42::/64"],
  ["2001:DB8:0:42:ffff:ffff:ffff:ffff", "2001:db8:0:42::/64"],
  ["2001:db8:0:42::1", "2001:db8:0:42::/64"],
  ["2001:db8::42:1", "2001:db8:0:0::/64"],
  ["2001:db8::", "2001:db8:0:0::/64"],
  ["::1", "0:0:0:0::/64"],
  ["::", "0:0:0:0::/64"],
  ["1:2:3::4:5:6:7", "1:2:3:0::/64"],
  ["1:2:3:4:5::", "1:2:3:4::/64"],
  ["64:ff9b::1.2.3.4", "64:ff9b:0:0::/64"],
  // With a zone id.
  ["fe80::1%eth0", "fe80:0:0:0::/64"],
  // IPv4-mapped: the IPv4 address, dotted or in hex.
  ["::ffff:203.0.113.7", "203.0.113.7"],
  ["::FFFF:cb00:7107", "203.0.113.7"],
  ["0:0:0:0:0:ffff:203.0.113.7", "203.0.113.7"],
  // Not an IP address.
  ["", null],
  ["unknown", null],
  ["203.0.113.7:8080", null],
  ["[2001:db8::1]", null],
  ["2001:db8::1::2", null],
  ["999.1.1.1", null],
])("clientKey(%j) → %j", (ip, expected) => {
  expect(clientKey(ip)).toBe(expected);
});

test("every address in a /64 is one visitor; the next /64 is another", () => {
  expect(clientKey("2001:db8:0:42::1")).toBe(clientKey("2001:db8:0:42:dead:beef:1:2"));
  expect(clientKey("2001:db8:0:42::1")).not.toBe(clientKey("2001:db8:0:43::1"));
});
