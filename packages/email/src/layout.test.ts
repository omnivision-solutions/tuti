import { render } from "@react-email/render";
import type { Doc } from "@tuti/content";
import { createElement, Fragment } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { changelogConfirmEmail } from "./changelog-confirm-email";
import { conversationReplyEmail } from "./conversation-reply-email";
import { passwordChangedEmail, passwordResetEmail } from "./password-reset-email";
import { portalReaderEmail } from "./portal-reader-email";
import { replyEmail } from "./reply-email";
import { signInLinkEmail } from "./sign-in-link-email";
import { changelogEmail } from "./changelog-email";
import { conversationEmail } from "./conversation-email";
import { creditsEmail } from "./credits-email";
import { emailLimitEmail } from "./email-limit-email";
import { inviteEmail } from "./invite-email";
import { accentColors, colors, Diff, Eyebrow, Note, POWERED_BY_URL, Stats, Title } from "./layout";
import { shippedEmail } from "./shipped-email";
import { verifyAllEmail } from "./verify-all-email";
import { verifyArticleEmail } from "./verify-article-email";

afterEach(() => {
  vi.unstubAllEnvs();
});

const shipped = { projectName: "Acme", postTitle: "Dark mode", postUrl: "https://acme.example/p/1", unsubscribeUrl: "https://acme.example/u" };

test("emails on a project's behalf show its name and initial at the top, not Tuti's mark; Tuti's own show the mark and the part of Tuti", async () => {
  vi.stubEnv("APP_URL", "https://tuti.example");
  const html = await render(shippedEmail(shipped).body);
  const text = await render(shippedEmail(shipped).body, { plainText: true });
  expect(text).toMatch(/^Acme\n/);
  expect(html).not.toContain("email-tuti.png");
  expect(html).not.toContain("email-logo.png");
  // Why they get it and how to stop, under the card.
  expect(text).toContain("You're getting this because you posted, voted, commented on or subscribed to it.");
  expect(html).toContain('href="https://acme.example/u"');

  const inbox = await render(
    conversationEmail({ projectName: "Acme", from: "Ann", isNew: true, subject: "Hi", body: "Hello", url: "https://tuti.example/c", assigned: true }).body,
  );
  expect(inbox).toContain('src="https://tuti.example/api/email-tuti.png"');
  expect(inbox).toContain(">Inbox</p>");
  expect(inbox).not.toContain("feedback, roadmap and changelog");
});

test("every email ends with Powered by tuti, linking to Tuti's site with no project in it, unless the project hides it", async () => {
  vi.stubEnv("APP_URL", "https://tuti.example");
  const link = 'href="https://tuti.so/?utm_source=email&amp;utm_medium=powered_by&amp;utm_campaign=badge"';
  expect(POWERED_BY_URL).toBe("https://tuti.so/?utm_source=email&utm_medium=powered_by&utm_campaign=badge");

  const shown = await render(shippedEmail({ ...shipped, poweredBy: true }).body);
  expect(shown).toContain(link);
  // Grey beside the team's colours.
  expect(shown).toContain('src="https://tuti.example/api/email-powered-by.png"');
  expect(await render(shippedEmail(shipped).body, { plainText: true })).toContain("Powered by");

  const hidden = await render(shippedEmail({ ...shipped, poweredBy: false }).body);
  expect(hidden).not.toContain("Powered by");
  expect(hidden).not.toContain("tuti.so");

  // Tuti's own emails always have it, in Tuti's colours.
  const invite = await render(inviteEmail({ inviterName: "Ann", projectName: "Acme", roleLabel: "Member", url: "https://tuti.example/i" }).body);
  expect(invite).toContain(link);
  expect(invite).toContain('src="https://tuti.example/api/email-powered-by-tuti.png"');

  // Without the app's address (or with one that isn't a URL), the words instead of the picture.
  for (const address of [undefined, "not a url"]) {
    vi.stubEnv("APP_URL", address);
    expect(await render(shippedEmail(shipped).body, { plainText: true })).toMatch(/Powered by\s+tuti/);
  }
});

test("emails a project's customers get take its accent", async () => {
  const html = (accent?: string | null) => render(shippedEmail({ ...shipped, accent }).body);

  const purple = await html("#7c3aed");
  // Its initial's square and its button.
  expect(purple).toContain("background-color:#7c3aed;color:#ffffff");
  expect(purple).toContain("background-color:#7c3aed;color:#ffffff;border-radius:10px");

  // A mid-tone that reads on white gets black text on its button.
  expect(await html("#ea580c")).toContain("background-color:#ea580c;color:#000000");
  // Too faint on the white card (a pale yellow): the darker shade of it the portal uses.
  const yellow = await html("#fde047");
  expect(yellow).not.toContain("#fde047");
  expect(yellow).toContain("background-color:#857525;color:#ffffff");

  // Without one (or with something that isn't a colour), Tuti's green as before.
  for (const accent of [null, "red;x:y"]) {
    expect(await html(accent)).toContain(`background-color:${colors.green};color:${colors.onGreen}`);
  }
});

test("a changelog entry's links take the project's accent", async () => {
  const doc: Doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "docs", marks: [{ type: "link", attrs: { href: "https://acme.example/docs" } }] }] }] };
  const html = await render(
    changelogEmail({ projectName: "Acme", entryTitle: "New", entryUrl: "https://acme.example/c/1", doc, unsubscribeUrl: "https://acme.example/u", accent: "#7c3aed" }).body,
  );
  expect(html).toMatch(/<a href="https:\/\/acme.example\/docs" style="color:#7c3aed/);
  // A grey that's enough for a button (3:1) but not for text this size (under 4.5:1): links in the text colour.
  const grey = await render(
    changelogEmail({ projectName: "Acme", entryTitle: "New", entryUrl: "https://acme.example/c/1", doc, unsubscribeUrl: "https://acme.example/u", accent: "#808080" }).body,
  );
  expect(grey).toMatch(new RegExp(`<a href="https://acme.example/docs" style="color:${colors.text}`));
  expect(grey).toContain("background-color:#808080");
});

test("an accent too faint on the white card takes the portal's shade of it, buttons and links alike; a grey or a pale tint, the text colour", () => {
  // The shades the portal's light mode gets (brandCss, branding.db.test.ts): mixed toward black until they read as text (4.5:1).
  expect(accentColors("#fde047")).toEqual({ accent: "#857525", onAccent: "#ffffff", link: "#857525" });
  expect(accentColors("#45b5f0")).toEqual({ accent: "#2f7ca5", onAccent: "#ffffff", link: "#2f7ca5" });
  // Beige's shade would be near grey, and white has no hue: the text colour, with white on it.
  for (const pale of ["#f5f5dc", "#ffffff"]) {
    expect(accentColors(pale)).toEqual({ accent: colors.text, onAccent: "#ffffff", link: colors.text });
  }
  // A dark blue already reads: as it is.
  expect(accentColors("#1e3a8a")).toEqual({ accent: "#1e3a8a", onAccent: "#ffffff", link: "#1e3a8a" });
  // Enough for a button (3:1) but not for text this size: the button as it is, links in its shade.
  expect(accentColors("#ea580c")).toEqual({ accent: "#ea580c", onAccent: "#000000", link: "#cb4c0a" });
});

test("the building blocks bodies share: the line over the title in the accent's text shade, a warning in the highlight", async () => {
  const html = await render(
    createElement(Fragment, null, Eyebrow({ accent: "#ea580c", children: "New reply" }), Title({ children: "Dark mode" }), Note({ kind: "warn", children: "Too many bounced." })),
  );
  expect(html).toMatch(/color:#cb4c0a[^>]*>New reply</);
  expect(html).toMatch(/<h1[^>]*>Dark mode<\/h1>/);
  expect(html).toMatch(new RegExp(`background-color:#fff4ea;color:${colors.onHighlight}[^>]*>Too many bounced.<`));
});

test("Tuti's own emails name the part of Tuti they're from: Verify for Verify's, Billing for credits and the email limit", async () => {
  const url = "https://tuti.example/x";
  const labels = await Promise.all(
    [
      verifyArticleEmail({ projectName: "Acme", articleTitle: "Export", counts: { current: 1, outdated: 1, unclear: 0 }, reason: "Moved.", url }),
      verifyAllEmail({ projectName: "Acme", checked: 2, total: 2, fixed: ["Export"], stopped: "", url }),
      creditsEmail({ projectName: "Acme", out: false, left: "120", url }),
      emailLimitEmail({ projectName: "Acme", planName: "Starter", limit: 1000, resets: "December 1", upgrade: "", url }),
    ].map(async (email) => (await render(email.body)).match(/>(Verify|Billing|Autopilot|Inbox)<\/p>/)?.[1]),
  );
  expect(labels).toEqual(["Verify", "Verify", "Billing", "Billing"]);
});

test("every email to a project's customers drops Powered by tuti when the project hides it, and keeps it otherwise", async () => {
  vi.stubEnv("APP_URL", "https://tuti.example");
  const u = "https://acme.example/x";
  const doc: Doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }] };
  const emails = (poweredBy: boolean) => {
    const brand = { projectName: "Acme", accent: null, poweredBy };
    return {
      shipped: shippedEmail({ ...brand, postTitle: "Dark mode", postUrl: u, unsubscribeUrl: u }),
      reply: replyEmail({ ...brand, authorName: "Ada", postTitle: "Dark mode", text: "Hi", doc, postUrl: u, unsubscribeUrl: u }),
      changelog: changelogEmail({ ...brand, entryTitle: "New", entryUrl: u, doc, unsubscribeUrl: u }),
      changelogConfirm: changelogConfirmEmail({ ...brand, url: u }),
      supportReply: conversationReplyEmail({ ...brand, subject: "Re: Hi", messages: [{ name: "Ada", body: "Hi" }] }),
      signInLink: signInLinkEmail({ ...brand, url: u, minutes: 15 }),
      passwordReset: passwordResetEmail({ project: brand, url: u, minutes: 60 }),
      passwordChanged: passwordChangedEmail(brand),
      portalReader: portalReaderEmail({ ...brand, inviterName: "Ada", email: "e2e-reader@example.com", url: u }),
    };
  };
  for (const [name, email] of Object.entries(emails(false))) {
    const html = await render(email.body);
    expect({ name, badge: html.includes("Powered by") || html.includes("tuti.so") }).toEqual({ name, badge: false });
  }
  for (const [name, email] of Object.entries(emails(true))) {
    const html = await render(email.body);
    expect({ name, badge: html.includes(`href="${POWERED_BY_URL.replaceAll("&", "&amp;")}"`) }).toEqual({ name, badge: true });
  }
});

test("Verify's emails count what it found on tiles: each number over what it counts", async () => {
  const url = "https://tuti.example/x";
  const article = await render(verifyArticleEmail({ projectName: "Acme", articleTitle: "Export", counts: { current: 8, outdated: 2, unclear: 1 }, reason: "Moved.", url }).body, { plainText: true });
  expect(article).toMatch(/8 still true\s+2 out of date\s+1 unclear/);
  expect(article).toContain("Help center · Verify");
  const all = await render(verifyAllEmail({ projectName: "Acme", checked: 8, total: 12, fixed: ["Export", "Seats"], stopped: "", url }).body, { plainText: true });
  expect(all).toMatch(/8 checked\s+4 not checked\s+2 fixes waiting/);
  expect(all).toMatch(/Fix waiting Export\s+Fix waiting Seats/);
  // All of them checked: no tile for what wasn't.
  const done = await render(verifyAllEmail({ projectName: "Acme", checked: 12, total: 12, fixed: ["Export"], stopped: "", url }).body, { plainText: true });
  expect(done).toMatch(/12 checked\s+1 fix waiting/);
  expect(done).not.toContain("not checked");
  // The tiles' numbers big, over a muted label.
  const html = await render(Stats({ items: [{ n: 8, label: "still true" }] }));
  expect(html).toMatch(/font-size:22px[^>]*>8<\/span> (<!-- -->)?still true/);
});

test("a diff: removed lines struck through on soft red, added on soft green, each with its sign; the lines left out under it", async () => {
  const lines = [
    { kind: "removed" as const, text: "Open the board and choose Export." },
    { kind: "added" as const, text: "Go to Settings → Data and choose Export CSV." },
  ];
  const html = await render(Diff({ lines, more: 4 }));
  expect(html).toMatch(new RegExp(`background-color:${colors.destructiveSoft}[\\s\\S]*?text-decoration:line-through">Open the board and choose Export.<`));
  expect(html).toMatch(new RegExp(`background-color:${colors.soft}[\\s\\S]*?text-decoration:none">Go to Settings → Data and choose Export CSV.<`));
  // Verify's email shows its fix's.
  const text = await render(
    verifyArticleEmail({ projectName: "Acme", articleTitle: "Export", counts: { current: 1, outdated: 1, unclear: 0 }, reason: "Moved.", diff: lines, diffMore: 4, url: "https://tuti.example/x" }).body,
    { plainText: true },
  );
  expect(text).toMatch(/− Open the board and choose Export.\s+\+ Go to Settings → Data and choose Export CSV.\s+4 more lines in Tuti/);
});
