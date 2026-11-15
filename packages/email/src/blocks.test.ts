import { render } from "@react-email/render";
import { createElement } from "react";
import { expect, test } from "vitest";

import { luminance } from "@tuti/shared/colors";

import { avatarColor, Message, PostCard, type PostStatus } from "./blocks";
import { conversationReplyEmail } from "./conversation-reply-email";
import { replyEmail } from "./reply-email";
import { shippedEmail } from "./shipped-email";

test("the post card's status pill takes the portal's hue for each status, never the app's", async () => {
  // packages/ui's globals.css, the portal's light mode (`status-*` under `[data-portal-top]`), as hex.
  const portal: Record<PostStatus, [string, string]> = {
    OPEN: ["Open", "#69625d"],
    UNDER_REVIEW: ["Under review", "#7d4dbe"],
    PLANNED: ["Planned", "#1467c2"],
    IN_PROGRESS: ["In progress", "#b14600"],
    COMPLETED: ["Completed", "#137738"],
    CLOSED: ["Closed", "#625c58"],
  };
  for (const [status, [label, hue]] of Object.entries(portal) as [PostStatus, [string, string]][]) {
    const html = await render(createElement(PostCard, { title: "Dark mode", status }));
    expect({ status, pill: new RegExp(`color:${hue}[^>]*>.*${label}</span>`).test(html) }).toEqual({ status, pill: true });
  }
  // The app's Under review is amber: not here.
  expect(await render(createElement(PostCard, { title: "Dark mode", status: "UNDER_REVIEW" }))).not.toMatch(/amber|#f59e0b|#d97706/);
});

test("the post card shows the votes, board and title it's given, and leaves out what it isn't", async () => {
  const text = await render(createElement(PostCard, { title: "Dark mode", votes: 128, board: "Feature requests", status: "PLANNED" }), { plainText: true });
  expect(text.replace(/\s+/g, " ").trim()).toBe("128 votes Feature requests Dark mode Planned");
  expect((await render(createElement(PostCard, { title: "Dark mode" }), { plainText: true })).trim()).toBe("Dark mode");
});

test("a team's message has its author's initial in their colour, their name and the team's tag in the accent", async () => {
  const html = await render(createElement(Message, { name: "ada Park", team: "Acme team", accent: "#7c3aed", children: "Shipped!" }));
  // Picked by the first letter, as AvatarFallback does: "ada" and "Ada" alike.
  expect(avatarColor("ada")).toBe(avatarColor("Ada R."));
  expect(html).toContain(`background-color:${avatarColor("Ada")};color:#ffffff`);
  expect(html).toMatch(/>A<\/td>/);
  expect(html).toMatch(/background-color:#f2ebfd;color:#7c3aed[^>]*>Acme team</);
  expect(html).toMatch(/border-radius:12px[^>]*>Shipped!</);
  // Someone else's message has no tag.
  expect(await render(createElement(Message, { name: "Sam", children: "Same here" }))).not.toContain("team");
});

test("the reply and shipped emails show the post's card and the team's message", async () => {
  const u = "https://acme.example/x";
  const reply = await render(
    replyEmail({ projectName: "Acme", authorName: "Ada", postTitle: "Dark mode", votes: 12, board: "Ideas", status: "PLANNED", text: "On it.", postUrl: u, unsubscribeUrl: u }).body,
    { plainText: true },
  );
  expect(reply.replace(/\s+/g, " ")).toContain("ADA FROM ACME REPLIED 12 votes Ideas Dark mode Planned Ada Acme team On it. Reply on the post");

  const shipped = await render(
    shippedEmail({ projectName: "Acme", postTitle: "Dark mode", votes: 12, board: "Ideas", postUrl: u, unsubscribeUrl: u, note: { from: "Ada", text: "Live now." } }).body,
    { plainText: true },
  );
  expect(shipped.replace(/\s+/g, " ")).toContain("12 votes Ideas Dark mode Completed Ada Acme team Live now.");
});

test("the team's tag reads on its own tint (4.5:1) in every accent, Tuti's green and an orange too", async () => {
  const ratio = (a: string, b: string) => {
    const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
    return (x! + 0.05) / (y! + 0.05);
  };
  for (const accent of [null, "#7c3aed", "#ea580c", "#fde047", "#808080"]) {
    const html = await render(createElement(Message, { name: "Ada", team: "Acme team", accent, children: "Hi" }));
    const [, fill, text] = html.match(/background-color:(#[0-9a-f]{6});color:(#[0-9a-f]{6})[^>]*>Acme team</)!;
    expect({ accent, readable: ratio(fill!, text!) >= 4.5 }).toEqual({ accent, readable: true });
  }
});

test("a support reply shows each message with the team's tag, and names the conversation without its Re:", async () => {
  const email = conversationReplyEmail({
    projectName: "Acme",
    accent: "#7c3aed",
    subject: "Re: Can't export CSV",
    messages: [
      { name: "Ada Park", body: "Fixed now." },
      // No teammate's name: the project's own, with no "Acme Acme team".
      { name: "Acme", body: "Anything else?" },
    ],
  });
  expect(email.subject).toBe("Re: Can't export CSV");
  const text = (await render(email.body, { plainText: true })).replace(/\s+/g, " ");
  expect(text).toContain("Ada Park Acme team Fixed now. Acme Anything else? Your conversation: Can't export CSV");
  expect(text).not.toContain("Acme Acme team");
});
