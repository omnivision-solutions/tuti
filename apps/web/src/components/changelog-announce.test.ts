import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/server/changelog", () => ({}));
vi.mock("@/server/branding", () => ({}));
vi.mock("@/server/widget", () => ({}));
vi.mock("@/server/media", () => ({}));

const { HowAnnounced, publishSummary, WhoSeesIt } = await import("./changelog");

/** The Publish dialog's line, as text (the count's popover aside). */
const line = (input: Partial<Parameters<typeof publishSummary>[0]>) => {
  const { start, count } = publishSummary({ email: true, subscribers: 0, emailedSubscribers: false, subscribersLeft: 0, posts: 0, asked: 0, ...input });
  return `${start}${count ?? ""}.`;
};

/** "How it's announced" in an entry's sidebar, as text. */
const sidebar = (
  entry: { published: boolean; emailedSubscribers: boolean; subscribersLeft: number; subscribersSent?: number; emailedFrom?: string | null; told?: { asked: number; subscribers: number } | null; emailPaused?: boolean; groups?: string[] },
  subscribers: number | null = 3,
) =>
  renderToStaticMarkup(
    createElement(HowAnnounced, {
      entry: {
        number: 1,
        title: "Dark mode",
        content: { type: "doc", content: [] },
        tags: [],
        groups: [],
        posts: [],
        cover: null,
        told: null,
        announced: true,
        subscribersSent: 0,
        ...entry,
      },
      subscribers,
    }),
  )
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replace(/\s+/g, " ")
    .trim();

describe("an entry emailed to some of its subscribers, not all (held, or unpublished before they all went)", () => {
  test("its draft says publishing sends it to those who haven't had it yet", () => {
    expect(sidebar({ published: false, emailedSubscribers: true, subscribersLeft: 300 })).toContain(
      "Publishing sends it to the 300 subscribers who haven't had it yet.",
    );
    expect(sidebar({ published: false, emailedSubscribers: true, subscribersLeft: 1 })).toContain(
      "Publishing sends it to the subscriber who hasn't had it yet.",
    );
    expect(publishSummary({ email: true, subscribers: 500, emailedSubscribers: true, subscribersLeft: 300, posts: 0, asked: 0 })).toEqual({
      start: "It goes on your portal and in your widget, and sends ",
      count: "300 emails",
      who: "300 to subscribers who haven't had it yet.",
    });
  });

  test("published, it says some are still to go", () => {
    expect(sidebar({ published: true, emailedSubscribers: true, subscribersLeft: 300 })).toContain("Being emailed to subscribers: 300 still to go.");
  });

  test("all sent: publishing again emails nobody, and says so", () => {
    expect(sidebar({ published: false, emailedSubscribers: true, subscribersLeft: 0, subscribersSent: 3 })).toContain(
      "Emailed to 3 subscribers when first published: not sent again.",
    );
    expect(line({ email: true, subscribers: 500, emailedSubscribers: true, subscribersLeft: 0 })).toBe("It goes on your portal and in your widget.");
    expect(line({ email: true, subscribers: 2, emailedSubscribers: false, subscribersLeft: 0 })).toBe("It goes on your portal and in your widget, and sends 2 emails.");
  });

  test("on a portal gone private (nobody's left to email: subscribersLeft is 0 there), the draft says the rest won't get it", () => {
    expect(sidebar({ published: false, emailedSubscribers: true, subscribersLeft: 0 }, null)).toContain(
      "Your portal is private now: nobody else gets it.",
    );
  });

  test("published, it says how many it went to: a send stopped short (its portal made private) says so, never just \"emailed\"", () => {
    expect(sidebar({ published: true, emailedSubscribers: true, subscribersLeft: 0, subscribersSent: 200 }, null)).toContain("Emailed to 200 subscribers.");
    expect(sidebar({ published: true, emailedSubscribers: true, subscribersLeft: 0, subscribersSent: 1 })).toContain("Emailed to 1 subscriber.");
  });

  test("a draft on a private portal (subscribers null: nothing is emailed from one) offers no email: the checkbox off and disabled, and says why", () => {
    const html = renderToStaticMarkup(
      createElement(HowAnnounced, {
        entry: { number: 1, title: "Dark mode", content: { type: "doc", content: [] }, tags: [], groups: [], posts: [], cover: null, told: null, announced: true, published: false, emailedSubscribers: false, subscribersLeft: 0, subscribersSent: 0 },
        subscribers: null,
      }),
    );
    expect(html).toMatch(/<input type="checkbox"[^>]*disabled=""[^>]*\/>[\s\S]*Email subscribers/);
    expect(html).not.toMatch(/<input type="checkbox"[^>]*checked=""[^>]*disabled=""/);
    expect(html).toContain("Your portal is private, so it isn&#x27;t emailed.");
    expect(line({ email: true, subscribers: 0, emailedSubscribers: false, subscribersLeft: 0 })).toBe("It goes on your portal and in your widget.");
  });
});

describe("published, who it told", () => {
  const told = (asked: number, subscribers: number) =>
    sidebar({ published: true, emailedSubscribers: subscribers > 0, subscribersLeft: 0, subscribersSent: subscribers, told: { asked, subscribers } });

  test("the people who asked, under the line on the subscribers: the subscribers aren't said twice", () => {
    expect(told(2, 48)).toContain("Emailed to 48 subscribers. Marked new in your widget. Told 2 people who asked.");
    expect(told(2, 48).split("48 subscribers").length - 1).toBe(1);
    expect(told(1, 0)).toContain("Told 1 person who asked.");
    expect(told(0, 1)).toContain("Emailed to 1 subscriber.");
    expect(told(0, 1)).not.toContain("Told");
    // Nobody told yet (being emailed, nothing sent): no "Told" line, not "Told 0 people who asked".
    expect(told(0, 0)).not.toContain("Told");
  });
});

test("a draft's choices each say one short line (docs/design.md: at most one under a label)", () => {
  const text = sidebar({ published: false, emailedSubscribers: false, subscribersLeft: 0 }, 3);
  expect(text).toBe("How it's announced Email subscribers 3 people subscribed. Mark it new A dot in your widget until readers see it.");
});

test("while the project's email is paused, a draft says subscribers aren't emailed, not that nobody subscribed", () => {
  expect(sidebar({ published: false, emailedSubscribers: false, subscribersLeft: 0, emailPaused: true }, 0)).toContain(
    "Your project's email is paused.",
  );
});

test("an entry emailed from the tool it was imported from says so, not that it went to 0 subscribers", () => {
  const imported = { emailedSubscribers: true, subscribersLeft: 0, subscribersSent: 0, emailedFrom: "Featurebase" };
  expect(sidebar({ ...imported, published: true })).toContain("Emailed to your subscribers from Featurebase.");
  expect(sidebar({ ...imported, published: false })).toContain("Emailed from Featurebase before: not sent again.");
  expect(sidebar({ ...imported, published: true })).not.toContain("0 subscribers");
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

  test("with Email subscribers off, only the people who asked are emailed", () => {
    const summary = publishSummary({ email: false, subscribers: 40, emailedSubscribers: false, subscribersLeft: 0, posts: 2, asked: 1 });
    expect(`${summary.start}${summary.count}.`).toBe("It goes on your portal and in your widget, completes 2 posts and sends 1 email.");
    expect(summary.who).toBe("1 to the people who asked for the posts it completes.");
  });

  test("nobody to email: no count", () => {
    expect(line({ posts: 1 })).toBe("It goes on your portal and in your widget, completes 1 post.");
  });
});

describe("Who sees it", () => {
  test("a draft for some groups counts, and says it counts, only the subscribers in them", () => {
    expect(sidebar({ published: false, emailedSubscribers: false, subscribersLeft: 0, groups: ["enterprise"] }, 0)).toContain("Nobody in its groups has subscribed.");
    expect(sidebar({ published: false, emailedSubscribers: false, subscribersLeft: 0, groups: ["enterprise"] }, 1)).toContain("1 person in its groups subscribed.");
    expect(sidebar({ published: false, emailedSubscribers: false, subscribersLeft: 0 }, 0)).toContain("Nobody has subscribed yet.");
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
    const id = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`id="${id}" hidden="">Reader groups need the Business plan</span>`);
    expect(picker(null)).not.toContain("aria-describedby");
  });
});
