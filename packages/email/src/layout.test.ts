import { render } from "@react-email/render";
import type { Doc } from "@tuti/content";
import { createElement, Fragment } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { changelogConfirmEmail } from "./changelog-confirm-email";
import { commentEmail } from "./comment-email";
import { conversationReplyEmail } from "./conversation-reply-email";
import { passwordChangedEmail, passwordResetEmail } from "./password-reset-email";
import { portalReaderEmail } from "./portal-reader-email";
import { replyEmail } from "./reply-email";
import { signInLinkEmail } from "./sign-in-link-email";
import { changelogEmail } from "./changelog-email";
import { conversationEmail } from "./conversation-email";
import { creditsEmail } from "./credits-email";
import { emailLimitEmail } from "./email-limit-email";
import { emailPausedTeamEmail } from "./email-paused-email";
import { verifyEmail } from "./verify-email";
import { autopilotEmail } from "./autopilot-email";
import { inviteEmail } from "./invite-email";
import { accentColors, Buttons, colors, Diff, type EmailBrand, Eyebrow, Note, POWERED_BY_URL, Stats, Title } from "./layout";
import { shippedEmail } from "./shipped-email";
import { statusEmail } from "./status-email";
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

test("a project's logo and name sit centred over the card; Tuti's own mark stays on the left", async () => {
  vi.stubEnv("APP_URL", "https://tuti.example");
  // The header row's table: its attributes before its style.
  const header = (html: string) => html.match(/<table([^>]*)style="margin:0 auto 16px"/)?.[1] ?? "";
  for (const brand of [{}, { logo: { url: "https://tuti.example/logo.webp", width: 64, height: 64 } }]) {
    const row = header(await render(shippedEmail({ ...shipped, ...brand }).body));
    // Centred, and only as wide as the logo and name.
    expect(row).toContain('align="center"');
    expect(row).not.toContain("width=");
  }
  // A logo alone keeps no gap on its right, which would push it off centre; with its text beside it, the gap stays.
  const logo = { url: "https://tuti.example/logo.webp", width: 64, height: 64 };
  const logoCell = (html: string) => html.match(/<td[^>]*style="([^"]*)"[^>]*><!--\[if !mso\]>/)?.[1] ?? "";
  expect(logoCell(await render(shippedEmail({ ...shipped, logo }).body))).not.toContain("padding-right:10px");
  expect(logoCell(await render(shippedEmail({ ...shipped, logo, logoText: "Acme" }).body))).toContain("padding-right:10px");
  const team = header(await render(inviteEmail({ inviterName: "Ann", projectName: "Acme", roleLabel: "Admin", url: "https://tuti.example/i" }).body));
  expect(team).toContain('width="100%"');
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
    changelogEmail({ projectName: "Acme", entryTitle: "New", entryUrl: "https://acme.example/c/1", publishedAt: new Date(), doc, unsubscribeUrl: "https://acme.example/u", accent: "#7c3aed" }).body,
  );
  expect(html).toMatch(/<a href="https:\/\/acme.example\/docs" style="color:#7c3aed/);
  // A grey that's enough for a button (3:1) but not for text this size (under 4.5:1): links in the text colour.
  const grey = await render(
    changelogEmail({ projectName: "Acme", entryTitle: "New", entryUrl: "https://acme.example/c/1", publishedAt: new Date(), doc, unsubscribeUrl: "https://acme.example/u", accent: "#808080" }).body,
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
  const emails = (poweredBy: boolean, more: Partial<EmailBrand> = {}) => {
    const brand = { projectName: "Acme", accent: null, poweredBy, ...more };
    return {
      shipped: shippedEmail({ ...brand, postTitle: "Dark mode", postUrl: u, unsubscribeUrl: u }),
      status: statusEmail({ ...brand, status: "IN_PROGRESS", postTitle: "Dark mode", board: "Feature requests", votes: 3, postUrl: u, unsubscribeUrl: u }),
      reply: replyEmail({ ...brand, authorName: "Ada", postTitle: "Dark mode", text: "Hi", doc, postUrl: u, unsubscribeUrl: u }),
      comment: commentEmail({ ...brand, postTitle: "Dark mode", voteCount: 3, status: "OPEN", comments: [{ authorId: "u-1", authorName: "Sam Lee", text: "Hi" }], postUrl: u, unsubscribeUrl: u }),
      changelog: changelogEmail({ ...brand, entryTitle: "New", entryUrl: u, publishedAt: new Date(), doc, unsubscribeUrl: u }),
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
  // The portal's logo heads every one of them, as the portal's header does.
  const logo = { url: "https://tuti.example/api/media/m1/480.webp?s=x", width: 480, height: 120 };
  for (const [name, email] of Object.entries(emails(true, { logo }))) {
    const html = await render(email.body);
    expect({ name, logo: html.includes(`<img src="${logo.url}" width="128" height="32" alt="Acme"`) }).toEqual({ name, logo: true });
  }
});

test("a customer email's header: the portal's logo and its text, with the letter's square for Outlook for Windows (no WebP there)", async () => {
  const url = "https://acme.example/x";
  const logo = { url: "https://tuti.example/api/media/m1/480.webp?s=a&b", width: 1000, height: 100 };
  const html = await render(signInLinkEmail({ projectName: "Acme", accent: "#ff0000", poweredBy: true, logo, logoText: "Acme Help", url, minutes: 15 }).body);
  // At most 160px wide; the text says the name, so the picture has no alt of its own.
  expect(html).toContain('<!--[if !mso]><!--><img src="https://tuti.example/api/media/m1/480.webp?s=a&amp;b" width="160" height="16" alt=""');
  expect(html).toMatch(/<!--\[if mso\]>.*>A<\/td>.*<!\[endif\]-->/);
  expect(html).toContain(">Acme Help</p>");
  expect(html).not.toMatch(/<!--\[if mso\]>.*>Acme<\/td>/);
  // A logo without text: the logo alone, as on the portal; Outlook for Windows gets the square and the name.
  const alone = await render(signInLinkEmail({ projectName: "Acme", logo, url, minutes: 15 }).body);
  expect(alone).toMatch(/<!--\[if mso\]>.*>A<\/td><td[^>]*>Acme<\/td>.*<!\[endif\]-->/);
  expect(alone).not.toMatch(/<p[^>]*>Acme<\/p>/);
  // No logo: the letter's square and the text, or the name, as the portal's LetterMark: the text's letter first.
  const none = await render(signInLinkEmail({ projectName: "Acme", logoText: "Help desk", url, minutes: 15 }).body);
  expect(none).not.toContain("<img");
  expect(none).toMatch(/>H<\/td>/);
  expect(none).toContain(">Help desk</p>");
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

test("Tuti's emails to teams open with a line in green saying what it's about, then a title that says what happened", async () => {
  const url = "https://tuti.example/x";
  const heads = async (email: { body: Parameters<typeof render>[0] }) => {
    const text = await render(email.body, { plainText: true });
    const html = await render(email.body);
    return { eyebrow: html.match(new RegExp(`font-weight:600;color:${colors.green}[^>]*>([^<]*(?:<!-- -->[^<]*)*)</p>`))?.[1]?.replaceAll("<!-- -->", ""), title: html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1]?.replaceAll("<!-- -->", ""), text };
  };
  expect(await heads(conversationEmail({ projectName: "Acme", from: "Jo", isNew: true, subject: "Can't export", body: "Hi", url, assigned: true }))).toMatchObject({ eyebrow: "New conversation · Acme" });
  expect(await heads(conversationEmail({ projectName: "Acme", from: "Jo", isNew: false, subject: "Export", body: "Hi", url, assigned: true }))).toMatchObject({ eyebrow: "New reply · Acme", title: "Export" });
  expect(await heads(inviteEmail({ inviterName: "Ada", projectName: "Acme", roleLabel: "Member", url }))).toMatchObject({ eyebrow: "You&#x27;re invited", title: "Join Acme on Tuti" });
  expect(await heads(verifyEmail({ name: "Ada", url }))).toMatchObject({ title: "Confirm your email, Ada" });
  expect(await heads(creditsEmail({ projectName: "Acme", out: false, left: "120", url }))).toMatchObject({ eyebrow: "Acme · Billing", title: "120 AI credits left" });
  expect(await heads(creditsEmail({ projectName: "Acme", out: true, left: "0", url }))).toMatchObject({ title: "Out of AI credits" });
  // One credit is singular, in the title and the text; a fraction of one isn't.
  const one = await heads(creditsEmail({ projectName: "Acme", out: false, left: "1", url }));
  expect(one).toMatchObject({ title: "1 AI credit left" });
  expect(one.text).toContain("Acme has 1 AI credit left.");
  expect(await heads(creditsEmail({ projectName: "Acme", out: false, left: "0.5", url }))).toMatchObject({ title: "0.5 AI credits left" });
  const limit = await heads(emailLimitEmail({ projectName: "Acme", planName: "Starter", limit: 1000, resets: "December 1", upgrade: "Upgrade to Pro for more.", url }));
  expect(limit).toMatchObject({ eyebrow: "Acme · Billing", title: "You&#x27;ve sent all 1,000 emails this month" });
  expect(limit.text).toContain("has sent the 1,000 emails its Starter plan includes this month");
  const paused = await heads(emailPausedTeamEmail({ projectName: "Acme", reason: "bounces", url }));
  expect(paused).toMatchObject({ eyebrow: "Acme · Email", title: "We paused Acme&#x27;s emails" });
  // The warnings in the highlight note.
  for (const email of [emailLimitEmail({ projectName: "Acme", planName: "Starter", limit: 1000, resets: "December 1", upgrade: "", url }), emailPausedTeamEmail({ projectName: "Acme", reason: "bounces", url })]) {
    expect(await render(email.body)).toContain(`background-color:#fff4ea;color:${colors.onHighlight}`);
  }
  expect(await heads(verifyArticleEmail({ projectName: "Acme", articleTitle: "Export", counts: { current: 1, outdated: 1, unclear: 0 }, reason: "", url }))).toMatchObject({ eyebrow: "Help center · Verify", title: "“Export” is out of date" });
  // Autopilot: one pull request is its title; several, what they need.
  const change = { title: "Add CSV export", pullRequest: "acme/app#1", summary: "", reviewUrl: url, goesOut: [], wentOut: [], done: [], needsYou: [{ kind: "Out of date", title: "Export", fact: "Publishes this edit" }] };
  const autopilot = (changes: (typeof change)[], digest = false) =>
    heads(autopilotEmail({ projectName: "Acme", changes, digest, totals: { needsYou: changes.length, goesOut: 0, wentOut: 0, first: "" }, more: 0, autopilotUrl: url, accountUrl: url }));
  expect(await autopilot([change])).toMatchObject({ eyebrow: "Acme · acme/app#1", title: "Add CSV export" });
  expect(await autopilot([change, { ...change, pullRequest: "acme/app#2" }])).toMatchObject({ eyebrow: "Acme · 2 merged pull requests", title: "2 need you" });
  expect(await autopilot([change, { ...change, pullRequest: "acme/app#2" }], true)).toMatchObject({ title: "2 still need you" });
});

test("four tiles lay out two by two, so a phone's card fits them; three stay in one row", async () => {
  const tiles = (n: number) => render(Stats({ items: Array.from({ length: n }, (_, i) => ({ n: i + 1, label: `tile ${i + 1}` })) }));
  const rows = (html: string) => html.match(/<tr>[\s\S]*?<\/tr>/g)!.filter((row) => row.includes("tile "));
  const four = rows(await tiles(4));
  expect(four).toHaveLength(2);
  expect(four.map((row) => row.match(/tile \d/g))).toEqual([["tile 1", "tile 2"], ["tile 3", "tile 4"]]);
  expect(four[0]).toContain('width="48%"');
  const three = rows(await tiles(3));
  expect(three).toHaveLength(1);
  expect(three[0]!.match(/tile \d/g)).toHaveLength(3);
});

test("two buttons side by side let a long label break, so a phone's card never scrolls sideways", async () => {
  const html = await render(createElement(Buttons, { href: "https://tuti.example/a", label: "Publish omnivision-solutions/tuti#848 now", second: { href: "https://tuti.example/b", label: "Stop omnivision-solutions/widget#848" } }));
  expect(html.match(/overflow-wrap:anywhere/g)?.length).toBe(2);
});

test("a diff line wraps a long word (a URL, a path), so a phone's card never scrolls sideways", async () => {
  const html = await render(createElement(Diff, { lines: [{ kind: "added", text: "See https://docs.example.com/a/very/long/path/that/has/no/spaces/at/all" }] }));
  expect(html).toContain("overflow-wrap:anywhere");
});

test("a title, an eyebrow and a note wrap a long word, so a phone's card never scrolls sideways", async () => {
  for (const element of [createElement(Title, null, "omnivision-solutions/a-very-long-repository-name#848"), createElement(Eyebrow, null, "x"), createElement(Note, null, "x")]) {
    expect(await render(element)).toContain("overflow-wrap:anywhere");
  }
});

test("the card itself wraps long words, so text in any email's body (an Autopilot update's title too) never makes a phone scroll", async () => {
  const html = await render(inviteEmail({ inviterName: "Ada", projectName: "Acme", roleLabel: "Member", url: "https://tuti.example/i" }).body);
  expect(html).toMatch(/border-radius:16px[^"]*overflow-wrap:anywhere/);
});
