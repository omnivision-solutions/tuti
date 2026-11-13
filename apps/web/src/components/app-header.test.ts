import { expect, test } from "vitest";

import { sectionOf } from "./app-header";

test("the top bar's path names the part of the project a page is in, a post's as Feedback; none on Home", () => {
  expect(sectionOf("/app/acme/feedback")).toBe("Feedback");
  expect(sectionOf("/app/acme/p/12")).toBe("Feedback");
  expect(sectionOf("/app/acme/feedback/roadmap")).toBe("Roadmap");
  expect(sectionOf("/app/acme/inbox/4")).toBe("Inbox");
  expect(sectionOf("/app/acme/settings/team")).toBe("Settings");
  expect(sectionOf("/app/acme")).toBeNull();
  expect(sectionOf("/app/account")).toBeNull();
});
