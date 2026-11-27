import { expect, test } from "vitest";

import { versionState, type VersionRow } from "./changelog-versions";

const at = new Date("2026-11-27T09:00:00.000Z");
const row = (changes: Partial<VersionRow>): VersionRow => ({ automatic: true, publishedAt: at, sourceHash: "now", error: null, behind: {}, ...changes });

test("each state a version's dot and label show", () => {
  expect(versionState(undefined, "now", true)).toBe("unwritten");
  expect(versionState(row({}), "now", true)).toBe("current");
  expect(versionState(row({ automatic: false }), "now", true)).toBe("written");
  // Kept up to date, made from older text (or never translated): on its way, unless it can't be.
  expect(versionState(row({ sourceHash: "before" }), "now", true)).toBe("translating");
  expect(versionState(row({ publishedAt: null, sourceHash: null }), "now", true)).toBe("translating");
  expect(versionState(row({ sourceHash: "before", error: "the provider didn't answer" }), "now", true)).toBe("waiting");
  expect(versionState(row({ sourceHash: "before" }), "now", false)).toBe("waiting");
  // The team's, behind: the entry's text changed, or the product setting marked it.
  expect(versionState(row({ automatic: false, sourceHash: "before" }), "now", true)).toBe("behind");
  expect(versionState(row({ automatic: false, behind: { "\u001f0": "The product setting changed" } }), "now", true)).toBe("setting");
  expect(versionState(row({ automatic: false, sourceHash: "before", behind: { "\u001f0": "The product setting changed" } }), "now", true)).toBe("behind");
  expect(versionState(row({ automatic: false, publishedAt: null, sourceHash: null }), "now", true)).toBe("unwritten");
});
