import { render } from "@react-email/render";
import { createElement } from "react";
import { expect, test } from "vitest";

import { luminance } from "@tuti/shared/colors";

import { avatarColor, Message, PostCard, type PostStatus } from "./blocks";
import { changelogConfirmEmail } from "./changelog-confirm-email";
import { conversationReplyEmail } from "./conversation-reply-email";
import { passwordChangedEmail, passwordResetEmail } from "./password-reset-email";
import { portalReaderEmail } from "./portal-reader-email";
import { replyEmail } from "./reply-email";
import { shippedEmail } from "./shipped-email";
import { signInLinkEmail } from "./sign-in-link-email";

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

test("the account and subscription emails: an eyebrow where it says what they're about, the heading, the body, the button and a soft note", async () => {
  const brand = { projectName: "Acme", accent: "#7c3aed" };
  const u = "https://acme.example/x";
  const read = async (body: Parameters<typeof render>[0]) => {
    const html = await render(body);
    const text = (await render(body, { plainText: true })).replace(/\s+/g, " ");
    return { html, text };
  };
  const eyebrow = (html: string) => html.match(/color:#7c3aed;margin:16px 0 8px[^>]*>([^<]+)</)?.[1] ?? null;
  const note = (html: string) => html.match(/border-radius:10px;background-color:(#[0-9a-f]{6})/)?.[1] ?? null;

  const confirm = await read(changelogConfirmEmail({ ...brand, url: u }).body);
  expect(eyebrow(confirm.html)).toBe("One more step");
  expect(confirm.text).toContain("CONFIRM YOUR SUBSCRIPTION Confirm to get the changelog entries Acme emails to subscribers");
  expect(confirm.text).toContain(`Confirm subscription ${u}`);
  const optedOut = await read(changelogConfirmEmail({ ...brand, url: u, optedOut: true }).body);
  expect(optedOut.text).toContain("TURN ACME'S EMAILS BACK ON");
  expect(optedOut.text).toContain(`Turn Acme's emails back on ${u}`);

  // Sign-in links and passwords: the heading says it, no eyebrow.
  const signIn = await read(signInLinkEmail({ ...brand, url: u, minutes: 15 }).body);
  expect(eyebrow(signIn.html)).toBeNull();
  expect(signIn.text).toContain(`SIGN IN TO ACME Here's your link to sign in to Acme. Sign in to Acme ${u} The link works once and expires in 15 minutes.`);
  expect(note(signIn.html)).toBe("#fafaf9");

  const reset = await read(passwordResetEmail({ project: brand, url: u, minutes: 60 }).body);
  expect(eyebrow(reset.html)).toBeNull();
  expect(reset.text).toContain(`RESET YOUR PASSWORD Someone asked to reset the password for your account on Acme. Set a new password ${u} The link works once and expires in 60 minutes.`);

  const changed = await read(passwordChangedEmail(brand).body);
  expect(changed.text).toContain("YOUR PASSWORD WAS CHANGED The password for your account was just changed");
  // If it wasn't them: a warning, not an aside.
  expect(note(changed.html)).toBe("#fff4ea");

  const invite = await read(portalReaderEmail({ ...brand, inviterName: "Ada", email: "e2e-reader@example.com", url: u }).body);
  expect(eyebrow(invite.html)).toBe("You&#x27;re invited");
  expect(invite.text).toContain(`ADA GAVE YOU ACCESS TO ACME'S PORTAL Read the docs, follow the changelog and share feedback with the Acme team. Open the portal ${u}`);
  expect(invite.text).toContain("Sign in as e2e-reader@example.com.");
  expect(note(invite.html)).toBe("#fafaf9");
});
