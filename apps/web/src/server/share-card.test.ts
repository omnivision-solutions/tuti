import { expect, test } from "vitest";

import { drawable } from "./share-card";

test("a card's text loses emoji and their parts, which its fonts can't draw", () => {
  expect(drawable("Launch 🇫🇷 day")).toBe("Launch day");
  expect(drawable("Thanks 👍🏽 team")).toBe("Thanks team");
  expect(drawable("Family 👨‍👩‍👧 plan")).toBe("Family plan");
  expect(drawable("Step 1️⃣ done ✅")).toBe("Step 1 done");
  expect(drawable("Café déjà vu")).toBe("Café déjà vu");
});
