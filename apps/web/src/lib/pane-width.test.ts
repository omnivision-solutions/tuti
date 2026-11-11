import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { PANE_WIDTHS, PANE_WIDTHS_SCRIPT, restorePaneWidths } from "./pane-width";

function restore(saved: Record<string, string>, blocked = false, client = false) {
  const properties: Record<string, string> = {};
  const globals = {
    localStorage: { getItem: (key: string) => { if (blocked) throw new Error("Storage blocked"); return saved[key] ?? null; } },
    document: { documentElement: { style: { setProperty: (key: string, value: string) => { properties[key] = value; } } } },
  };
  if (client) {
    try {
      vi.stubGlobal("localStorage", globals.localStorage);
      vi.stubGlobal("document", globals.document);
      restorePaneWidths();
    } finally {
      vi.unstubAllGlobals();
    }
  } else runInNewContext(PANE_WIDTHS_SCRIPT, globals);
  return properties;
}

describe.each(["inline script", "client entry"])("pane widths before paint: %s", (source) => {
  const run = (saved: Record<string, string>, blocked = false) => restore(saved, blocked, source === "client entry");
  it("restores each pane independently, clamping old or out-of-range preferences", () => {
    expect(run({ [PANE_WIDTHS.docs.key]: "200", [PANE_WIDTHS.inbox.key]: "900" })).toEqual({ "--docs-tree-width": "240px", "--inbox-list-width": "520px" });
    expect(run({ [PANE_WIDTHS.inbox.key]: "300" })).toEqual({ "--inbox-list-width": "352px" });
    expect(run({ [PANE_WIDTHS.docs.key]: "400", [PANE_WIDTHS.inbox.key]: "480" })).toEqual({ "--docs-tree-width": "400px", "--inbox-list-width": "480px" });
  });

  it("leaves CSS defaults in place for missing, invalid or unavailable storage", () => {
    for (const value of ["", "0", "-1", "NaN", "Infinity", "not-a-width"]) {
      expect(run({ [PANE_WIDTHS.docs.key]: value })).toEqual({});
    }
    expect(run({})).toEqual({});
    expect(run({}, true)).toEqual({});
  });
});
