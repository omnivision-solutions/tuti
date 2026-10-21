import type { NoAccess, ReadAccess } from "@tuti/db";
import { describe, expect, test } from "vitest";

import { accessBadge, allows, describeAccess, type Level, locks, readable, type Reader, restricted, SIGNED_OUT } from "./read-access";

const level = (access: ReadAccess, ...groups: string[]): Level => ({ access, groups: groups.map((key) => ({ group: { key } })) });
const inherit = level("INHERIT");
const signedIn = level("SIGNED_IN");
const enterprise = level("GROUPS", "enterprise", "pro");
const teamOnly = level("GROUPS");

const team: Reader = null;
const stranger: Reader = { signedIn: true, groups: [] };
const customer: Reader = { signedIn: true, groups: ["enterprise"] };
const beta: Reader = { signedIn: true, groups: ["beta"] };

describe("allows: one level on its own", () => {
  test.each([
    ["inherit", inherit, { team: true, signedOut: true, stranger: true, customer: true, beta: true }],
    ["signed-in readers", signedIn, { team: true, signedOut: false, stranger: true, customer: true, beta: true }],
    ["groups", enterprise, { team: true, signedOut: false, stranger: false, customer: true, beta: false }],
    ["groups, with none picked: only the team", teamOnly, { team: true, signedOut: false, stranger: false, customer: false, beta: false }],
  ])("%s", (_, it, expected) => {
    expect({
      team: allows(team, it),
      signedOut: allows(SIGNED_OUT, it),
      stranger: allows(stranger, it),
      customer: allows(customer, it),
      beta: allows(beta, it),
    }).toEqual(expected);
  });

  test("a missing level (no tab) lets everyone through", () => {
    expect([allows(SIGNED_OUT, null), allows(SIGNED_OUT, undefined)]).toEqual([true, true]);
  });
});

describe("readable: every level from the tab down", () => {
  const all = [inherit, signedIn, enterprise, teamOnly];

  test("each combination of a parent and a child is as narrow as the narrower of the two", () => {
    for (const parent of all) {
      for (const child of all) {
        for (const reader of [SIGNED_OUT, stranger, customer, beta]) {
          expect(readable(reader, parent, child)).toBe(allows(reader, parent) && allows(reader, child));
        }
      }
    }
  });

  test("a child can't widen what's above it: inherit under groups stays for the groups", () => {
    expect(readable(stranger, enterprise, inherit)).toBe(false);
    expect(readable(SIGNED_OUT, signedIn, inherit, inherit)).toBe(false);
    expect(readable(customer, enterprise, inherit)).toBe(true);
  });

  test("two group levels need a group of each", () => {
    const both: Reader = { signedIn: true, groups: ["enterprise", "beta"] };
    expect(readable(customer, enterprise, level("GROUPS", "beta"))).toBe(false);
    expect(readable(both, enterprise, level("GROUPS", "beta"))).toBe(true);
  });

  test("the team reads everything, even what's for no group", () => {
    expect(readable(team, teamOnly, signedIn, enterprise)).toBe(true);
  });

  test("restricted: any level that isn't inherit", () => {
    expect(restricted([null, inherit, inherit])).toBe(false);
    expect(restricted([null, inherit, signedIn])).toBe(true);
    expect(restricted([teamOnly])).toBe(true);
  });
});

test("describeAccess says who may read under the levels together", () => {
  const named = (access: ReadAccess, ...groups: string[]) => ({ access, groups });
  expect(describeAccess([])).toBe("Anyone can read it");
  expect(describeAccess([named("INHERIT"), named("INHERIT")])).toBe("Anyone can read it");
  expect(describeAccess([named("SIGNED_IN"), named("INHERIT")])).toBe("Signed-in readers");
  expect(describeAccess([named("SIGNED_IN"), named("GROUPS", "Enterprise", "Pro")])).toBe("Readers in Enterprise or Pro");
  expect(describeAccess([named("GROUPS", "Enterprise", "Pro"), named("GROUPS", "Beta")])).toBe("Readers in Enterprise or Pro, and in Beta");
  expect(describeAccess([named("GROUPS", "Enterprise"), named("GROUPS")])).toBe("Only your team");
});

test("accessBadge: none for inherit", () => {
  expect(accessBadge({ access: "INHERIT", groups: [] })).toBeNull();
  expect(accessBadge({ access: "SIGNED_IN", groups: [] })).toBe("Signed-in");
  expect(accessBadge({ access: "GROUPS", groups: ["Enterprise", "Pro"] })).toBe("Enterprise, Pro");
  expect(accessBadge({ access: "GROUPS", groups: [] })).toBe("Team only");
});

describe("locks: what people without access see, from the nearest level that says", () => {
  const shown = (noAccess: NoAccess) => ({ noAccess });
  const [inherits, lock, hide] = [shown("INHERIT"), shown("LOCK"), shown("HIDE")];

  test("nothing set anywhere (or no levels): hidden, as before", () => {
    expect(locks()).toBe(false);
    expect(locks(null, inherits, inherits, inherits)).toBe(false);
  });

  test("a level's own choice wins over what's above it", () => {
    expect(locks(hide, inherits, lock)).toBe(true);
    expect(locks(lock, inherits, hide)).toBe(false);
  });

  test("inherit takes the nearest level above that says, from the collection it's in up to the tab", () => {
    expect(locks(lock, inherits, inherits)).toBe(true);
    expect(locks(hide, lock, inherits)).toBe(true);
    expect(locks(lock, hide, inherits)).toBe(false);
    expect(locks(undefined, lock, inherits)).toBe(true);
  });
});
