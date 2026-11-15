import { expect, test } from "vitest";

import { drawable, logoSize } from "./share-card";

test("a card's text loses emoji and their parts, which its fonts can't draw", () => {
  expect(drawable("Launch 🇫🇷 day")).toBe("Launch day");
  expect(drawable("Thanks 👍🏽 team")).toBe("Thanks team");
  expect(drawable("Family 👨‍👩‍👧 plan")).toBe("Family plan");
  expect(drawable("Step 1️⃣ done ✅")).toBe("Step 1 done");
  expect(drawable("Café déjà vu")).toBe("Café déjà vu");
});

test("a logo is read at the smallest stored width twice what the card shows it at, never scaled up", () => {
  // A wide wordmark: 512×64 on the card, from the 1600px copy (480 or 960 would be blown up).
  expect(logoSize({ width: 2000, height: 250 })).toEqual({ width: 512, height: 64, stored: 1600 });
  // A square mark: 64×64, from the smallest copy.
  expect(logoSize({ width: 512, height: 512 })).toEqual({ width: 64, height: 64, stored: 480 });
  // Smaller than twice its size on the card: the original.
  expect(logoSize({ width: 300, height: 100 })).toEqual({ width: 192, height: 64, stored: 300 });
});
