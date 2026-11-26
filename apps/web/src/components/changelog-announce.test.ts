import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/server/changelog", () => ({}));
vi.mock("@/server/images", () => ({}));
vi.mock("@/server/branding", () => ({}));
vi.mock("@/server/widget", () => ({}));
vi.mock("@/server/media", () => ({}));

const { publishSummary, WhoSeesIt } = await import("./changelog");

/** The Publish dialog's line, as text (the count's popover aside). */
const line = (input: Partial<Parameters<typeof publishSummary>[0]>) => {
  const { start, count } = publishSummary({ email: true, subscribers: 0, emailedSubscribers: false, subscribersLeft: 0, posts: 0, asked: 0, ...input });
  return `${start}${count ?? ""}.`;
};

type Sidebar = { published: boolean; emailedSubscribers: boolean; subscribersLeft: number; subscribersSent?: number; emailedFrom?: string | null; told?: { asked: number; subscribers: number } | null; emailPaused?: boolean; groups?: string[]; privatePortal?: boolean; emailOnly?: boolean; sample?: boolean; importedOn?: string | null };

/** "Goes to" in an entry's sidebar, as markup. */
const markup = (entry: Sidebar, subscribers = 3) =>
  renderToStaticMarkup(
    createElement(WhoSeesIt, {
      groups: [],
      picked: [],
      emailOnly: entry.emailOnly,
      upgrade: null,
      onChange: () => {},
      entry: { number: 1, title: "Dark mode", content: { type: "doc", content: [] }, tags: [], groups: [], posts: [], cover: null, told: null, announced: true, subscribersSent: 0, ...entry },
      subscribers,
    }),
  );

/** The same, as text. */
const sidebar = (entry: Sidebar, subscribers = 3) =>
  markup(entry, subscribers)
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replace(/\s+/g, " ")
    .trim();

/** A switch's tag, by its label. */
const switchFor = (html: string, label: string) => {
  const id = new RegExp(`<label for="([^"]+)">${label}</label>`).exec(html)?.[1];
  return new RegExp(`<input[^>]*id="${id}"[^>]*/>`).exec(html)?.[0] ?? "";
};

describe("an entry emailed to some of its subscribers, not all (held, or unpublished before they all went)", () => {
  test("its draft says publishing sends it to those who haven't had it yet", () => {
    expect(sidebar({ published: false, emailedSubscribers: true, subscribersLeft: 300 })).toContain(
      "Email announcement 300 subscribers still to go",
    );
    expect(sidebar({ published: false, emailedSubscribers: true, subscribersLeft: 1 })).toContain("1 subscriber still to go");
    // On, and not to be turned off: publishing sends theirs.
    const email = switchFor(markup({ published: false, emailedSubscribers: true, subscribersLeft: 1 }), "Email announcement");
    expect(email).toContain('checked=""');
    expect(email).toContain('disabled=""');
    expect(publishSummary({ email: true, subscribers: 500, emailedSubscribers: true, subscribersLeft: 300, posts: 0, asked: 0 })).toEqual({
      start: "It goes on your portal and in your widget, and sends ",
      count: "300 emails",
      who: "300 to subscribers who haven't had it yet.",
    });
  });

  test("published, it says some are still to go", () => {
    expect(sidebar({ published: true, emailedSubscribers: true, subscribersLeft: 300 })).toContain("300 subscribers still to go");
  });

  test("all sent: publishing again emails nobody, and says so", () => {
    expect(sidebar({ published: false, emailedSubscribers: true, subscribersLeft: 0, subscribersSent: 3 })).toContain("Sent to 3 subscribers");
    expect(line({ email: true, subscribers: 500, emailedSubscribers: true, subscribersLeft: 0 })).toBe("It goes on your portal and in your widget.");
    expect(line({ email: true, subscribers: 2, emailedSubscribers: false, subscribersLeft: 0 })).toBe("It goes on your portal and in your widget, and sends 2 emails.");
  });

  test("published, it says how many it went to: a send stopped short (its portal made private) says so, never just \"emailed\"", () => {
    expect(sidebar({ published: true, emailedSubscribers: true, subscribersLeft: 0, subscribersSent: 200 }, 0)).toContain("Sent to 200 subscribers");
    expect(sidebar({ published: true, emailedSubscribers: true, subscribersLeft: 0, subscribersSent: 1 })).toContain("Sent to 1 subscriber");
  });

  test("with nobody to email (none subscribed, or on a private portal none who may read it), the switch is off and disabled", () => {
    const html = markup({ published: false, emailedSubscribers: false, subscribersLeft: 0 }, 0);
    expect(switchFor(html, "Email announcement")).toContain('disabled=""');
    expect(switchFor(html, "Email announcement")).not.toContain('checked=""');
    expect(sidebar({ published: false, emailedSubscribers: false, subscribersLeft: 0 }, 0)).toContain("Email announcement No subscribers yet");
    // On a private portal, it's its readers who're counted.
    expect(sidebar({ published: false, emailedSubscribers: false, subscribersLeft: 0, privatePortal: true }, 0)).toContain("No readers subscribed");
    expect(sidebar({ published: false, emailedSubscribers: false, subscribersLeft: 0, privatePortal: true }, 1)).toContain("1 reader subscribed");
    expect(line({ email: true, subscribers: 0, emailedSubscribers: false, subscribersLeft: 0 })).toBe("It goes on your portal and in your widget.");
  });
});

describe("published, who it told", () => {
  const told = (asked: number, subscribers: number) =>
    sidebar({ published: true, emailedSubscribers: subscribers > 0, subscribersLeft: 0, subscribersSent: subscribers, told: { asked, subscribers } });

  test("the people who asked, under the line on the subscribers: the subscribers aren't said twice", () => {
    expect(told(2, 48)).toContain("Sent to 48 subscribers · told 2 people who asked");
    expect(told(2, 48).split("48 subscribers").length - 1).toBe(1);
    expect(told(1, 0)).toContain("Published without it · told 1 person who asked");
    expect(told(0, 1)).toContain("Sent to 1 subscriber");
    expect(told(0, 1)).not.toContain("told");
    // Nobody told yet (being emailed, nothing sent): no "told", not "told 0 people who asked".
    expect(told(0, 0)).not.toContain("told");
  });
});

test("a draft's Goes to says no more than the subscribers' count: no hints", () => {
  expect(sidebar({ published: false, emailedSubscribers: false, subscribersLeft: 0 }, 3)).toBe("Goes to Changelog list Widget popup Email announcement 3 subscribers");
  expect(sidebar({ published: false, emailedSubscribers: false, subscribersLeft: 0 }, 1)).toBe("Goes to Changelog list Widget popup Email announcement 1 subscriber");
});

test("while the project's email is paused, a draft says so, not that nobody subscribed", () => {
  expect(sidebar({ published: false, emailedSubscribers: false, subscribersLeft: 0, emailPaused: true }, 0)).toContain("Your project's email is paused");
});

test("an entry emailed from the tool it was imported from says so, not that it went to 0 subscribers", () => {
  const imported = { emailedSubscribers: true, subscribersLeft: 0, subscribersSent: 0, emailedFrom: "Featurebase" };
  expect(sidebar({ ...imported, published: true })).toContain("Sent from Featurebase");
  expect(sidebar({ ...imported, published: false })).toContain("Sent from Featurebase");
  expect(sidebar({ ...imported, published: true })).not.toContain("0 subscribers");
});

test("where publishing can't announce it (a sample entry, an imported one, one published without email), the popup and the email are off and disabled, with the reason", () => {
  const draft = { published: false, emailedSubscribers: false, subscribersLeft: 0 };
  for (const [entry, reason] of [
    [{ ...draft, sample: true }, "Not for sample entries"],
    [{ ...draft, importedOn: "2 April 2024" }, "Published 2 April 2024, before the import"],
  ] as const) {
    const html = markup(entry);
    for (const label of ["Widget popup", "Email announcement"]) {
      expect(switchFor(html, label)).toContain('disabled=""');
      expect(switchFor(html, label)).not.toContain('checked=""');
    }
    expect(sidebar(entry)).toContain(`Widget popup ${reason} Email announcement ${reason}`);
  }
  const quietly = markup({ ...draft, published: true });
  expect(switchFor(quietly, "Email announcement")).toContain('disabled=""');
  expect(switchFor(quietly, "Email announcement")).not.toContain('checked=""');
  expect(sidebar({ ...draft, published: true })).toContain("Email announcement Published without it");
});

describe("the Publish dialog's line", () => {
  test("one line: where it goes, the posts it completes, and how many emails it sends, who to in the count's popover", () => {
    const summary = publishSummary({ email: true, subscribers: 1, emailedSubscribers: false, subscribersLeft: 0, posts: 1, asked: 3 });
    expect(`${summary.start}${summary.count}.`).toBe("It goes on your portal and in your widget, completes 1 post and sends 4 emails.");
    expect(summary.who).toBe("1 to your subscriber, and 3 to the people who asked for the post it completes.");
  });

  test("emails, not people: a subscriber who asked too, or someone who asked for two of its posts, gets each email", () => {
    // Ada subscribes and voted on both posts: the changelog's email, and each post's Completed one (emailedOnCompletion's 1 + 1).
    const summary = publishSummary({ email: true, subscribers: 1, emailedSubscribers: false, subscribersLeft: 0, posts: 2, asked: 2 });
    expect(summary.count).toBe("3 emails");
    expect(summary.who).toBe("1 to your subscriber, and 2 to the people who asked for the posts it completes.");
  });

  test("with Email announcement off, only the people who asked are emailed", () => {
    const summary = publishSummary({ email: false, subscribers: 40, emailedSubscribers: false, subscribersLeft: 0, posts: 2, asked: 1 });
    expect(`${summary.start}${summary.count}.`).toBe("It goes on your portal and in your widget, completes 2 posts and sends 1 email.");
    expect(summary.who).toBe("1 to the people who asked for the posts it completes.");
  });

  test("nobody to email: no count", () => {
    expect(line({ posts: 1 })).toBe("It goes on your portal and in your widget, completes 1 post.");
  });
});

test("an email-only entry's widget popup is off and disabled (it's in no widget), before publishing or after", () => {
  for (const published of [false, true]) {
    const entry = { published, emailOnly: true, emailedSubscribers: false, subscribersLeft: 0 };
    expect(switchFor(markup(entry, 1), "Widget popup")).toContain('disabled=""');
    expect(switchFor(markup(entry, 1), "Widget popup")).not.toContain('checked=""');
    expect(sidebar(entry, 1)).toContain("Widget popup Needs the changelog list");
  }
});

test("an email-only entry's Publish line says it's listed nowhere", () => {
  const { start, count } = publishSummary({ email: true, subscribers: 3, emailedSubscribers: false, subscribersLeft: 0, posts: 0, asked: 0, emailOnly: true });
  expect(`${start}${count}.`).toBe("It's listed nowhere, and sends 3 emails.");
});

describe("Audience", () => {
  test("a draft for some groups counts, and says it counts, only the subscribers in them", () => {
    expect(sidebar({ published: false, emailedSubscribers: false, subscribersLeft: 0, groups: ["enterprise"] }, 0)).toContain("No subscribers in its groups");
    expect(sidebar({ published: false, emailedSubscribers: false, subscribersLeft: 0, groups: ["enterprise"] }, 1)).toContain("1 subscriber in its groups");
    expect(sidebar({ published: false, emailedSubscribers: false, subscribersLeft: 0 }, 0)).toContain("No subscribers yet");
  });

  const groups = [{ key: "enterprise", name: "Enterprise" }];
  const picker = (upgrade: { title: string; billingHref: string | null; note: string | null } | null) =>
    renderToStaticMarkup(createElement(WhoSeesIt, { groups, picked: ["enterprise"], upgrade, onChange: () => {} }));

  test("the groups are sent only once a pick changes: a save of the text keeps the ones set meanwhile, and needs no plan for them", () => {
    expect(picker(null)).toMatch(/<input type="checkbox"[^>]*name="groups" checked="" value="enterprise"/);
    expect(picker(null)).not.toContain("groupsEditable");
  });

  test("on a plan without reader groups, each group's description names the plan it needs", () => {
    const html = picker({ title: "Reader groups need the Business plan", billingHref: null, note: null });
    const id = /name="groups"[^>]*aria-describedby="([^"]+)"|aria-describedby="([^"]+)"[^>]*name="groups"/.exec(html)?.slice(1).find(Boolean);
    expect(id).toBeTruthy();
    expect(html).toContain(`id="${id}" hidden="">Reader groups need the Business plan</span>`);
    expect(picker(null)).not.toMatch(/<input[^>]*name="groups"[^>]*aria-describedby/);
  });
});
