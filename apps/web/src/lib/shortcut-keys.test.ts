import { expect, test } from "vitest";

import { shortcutLabel } from "./shortcut-keys";

test("⌘ on Apple's platforms, Ctrl elsewhere", () => {
  for (const platform of ["MacIntel", "macOS", "iPhone", "iPad"]) {
    expect(shortcutLabel("K", platform)).toBe("⌘K");
  }
  for (const platform of ["Win32", "Windows", "Linux x86_64", "Android", "ChromeOS", ""]) {
    expect(shortcutLabel("K", platform)).toBe("Ctrl K");
  }
});
