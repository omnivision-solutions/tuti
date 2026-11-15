import { render } from "@react-email/render";
import { expect, test } from "vitest";

import { statusEmail } from "./status-email";

const props = {
  projectName: "Acme",
  postTitle: "CSV export with tags",
  boardName: "Feature requests",
  votes: 64,
  postUrl: "https://acme.example/p/1",
  unsubscribeUrl: "https://acme.example/u",
};

test("In progress: the news, the post with its votes and status, what comes next, and the team's note", async () => {
  const email = statusEmail({ ...props, status: "IN_PROGRESS", note: { from: "Ada", text: "Out next week." } });
  expect(email.subject).toBe("In progress: CSV export with tags");
  const text = await render(email.body, { plainText: true });
  for (const part of [
    "Update on an idea you asked for",
    "CSV export with tags is in progress",
    "Feature requests",
    "64",
    "In progress",
    "The team has started building it. We'll email you again when it ships.",
    "Ada from the team:",
    "Out next week.",
    "See the idea",
    "Unsubscribe from Acme",
  ]) {
    expect(text).toContain(part);
  }
  // True for everyone it reaches (authors, commenters and followers, not only voters), and the pill in the portal's orange.
  expect(text).not.toContain("voted for");
  const html = await render(email.body);
  expect(html).toContain("An idea you&#x27;re following moved to In progress");
  expect(html).toContain("color:#b14600");
});

test("Planned: its own words, and no note when the change came without one", async () => {
  const email = statusEmail({ ...props, status: "PLANNED" });
  expect(email.subject).toBe("Planned: CSV export with tags");
  const text = await render(email.body, { plainText: true });
  expect(text).toContain("CSV export with tags is planned");
  expect(text).toContain("The team plans to build it. We'll email you again when it ships.");
  expect(text).not.toContain("from the team");
  // The portal's blue.
  expect(await render(email.body)).toContain("color:#1467c2");
});
