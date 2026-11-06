import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/server/changelog", () => ({}));
vi.mock("@/server/branding", () => ({}));
vi.mock("@/server/widget", () => ({}));
vi.mock("@/server/media", () => ({}));

const { HowAnnounced, publishSummary } = await import("./changelog");

/** "How it's announced" in an entry's sidebar, as text. */
const sidebar = (
  entry: { published: boolean; emailedSubscribers: boolean; subscribersLeft: number; subscribersSent?: number; emailedFrom?: string | null; told?: { asked: number; subscribers: number } | null; emailPaused?: boolean },
  subscribers: number | null = 3,
) =>
  renderToStaticMarkup(
    createElement(HowAnnounced, {
      entry: {
        number: 1,
        title: "Dark mode",
        content: { type: "doc", content: [] },
        tags: [],
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
    expect(publishSummary({ markNew: true, email: true, subscribers: 500, emailedSubscribers: true, subscribersLeft: 300 })).toBe(
      "It appears on your portal's changelog, marked new in your widget, and it's sent to the 300 subscribers who haven't had it yet.",
    );
  });

  test("published, it says some are still to go", () => {
    expect(sidebar({ published: true, emailedSubscribers: true, subscribersLeft: 300 })).toContain("Being emailed to subscribers: 300 still to go.");
  });

  test("all sent: publishing again emails nobody, and says so", () => {
    expect(sidebar({ published: false, emailedSubscribers: true, subscribersLeft: 0, subscribersSent: 3 })).toContain(
      "Emailed to 3 subscribers when it was first published: it isn't sent again.",
    );
    expect(publishSummary({ markNew: false, email: true, subscribers: 500, emailedSubscribers: true, subscribersLeft: 0 })).toBe(
      "It appears on your portal's changelog.",
    );
    expect(publishSummary({ markNew: true, email: true, subscribers: 2, emailedSubscribers: false, subscribersLeft: 0 })).toBe(
      "It appears on your portal's changelog, marked new in your widget, and it's emailed to your 2 subscribers.",
    );
  });

  test("on a portal gone private (nobody's left to email: subscribersLeft is 0 there), the draft says the rest won't get it", () => {
    expect(sidebar({ published: false, emailedSubscribers: true, subscribersLeft: 0 }, null)).toContain(
      "Your portal is private now: it isn't emailed to anyone else.",
    );
  });

  test("published, it says how many it went to: a send stopped short (its portal made private) says so, never just \"emailed\"", () => {
    expect(sidebar({ published: true, emailedSubscribers: true, subscribersLeft: 0, subscribersSent: 200 }, null)).toContain("Emailed to 200 subscribers.");
    expect(sidebar({ published: true, emailedSubscribers: true, subscribersLeft: 0, subscribersSent: 1 })).toContain("Emailed to 1 subscriber.");
  });

  test("a draft on a private portal (subscribers null: nothing is emailed from one) offers no email: the checkbox off and disabled, and says why", () => {
    const html = renderToStaticMarkup(
      createElement(HowAnnounced, {
        entry: { number: 1, title: "Dark mode", content: { type: "doc", content: [] }, tags: [], posts: [], cover: null, told: null, announced: true, published: false, emailedSubscribers: false, subscribersLeft: 0, subscribersSent: 0 },
        subscribers: null,
      }),
    );
    expect(html).toMatch(/<input type="checkbox"[^>]*disabled=""[^>]*\/>[\s\S]*Email subscribers/);
    expect(html).not.toMatch(/<input type="checkbox"[^>]*checked=""[^>]*disabled=""/);
    expect(html).toContain("Your portal is private: its changelog isn&#x27;t emailed.");
    expect(publishSummary({ markNew: true, email: true, subscribers: 0, emailedSubscribers: false, subscribersLeft: 0 })).toBe(
      "It appears on your portal's changelog, marked new in your widget.",
    );
  });
});

describe("published, who it told", () => {
  const told = (asked: number, subscribers: number) =>
    sidebar({ published: true, emailedSubscribers: subscribers > 0, subscribersLeft: 0, subscribersSent: subscribers, told: { asked, subscribers } });

  test("the people who asked and the subscribers, each counted as what they are", () => {
    expect(told(2, 48)).toContain("Told 2 people who asked and 48 subscribers.");
    expect(told(1, 0)).toContain("Told 1 person who asked.");
    expect(told(0, 1)).toContain("Told 1 subscriber.");
    expect(told(0, 1)).not.toContain("who asked");
    // Nobody told yet (being emailed, nothing sent): no "Told" line, not "Told 0 people who asked".
    expect(told(0, 0)).not.toContain("Told");
  });
});

test("a draft's Mark it new says what each place shows: the widget a dot, the portal's Changelog tab New", () => {
  expect(sidebar({ published: false, emailedSubscribers: false, subscribersLeft: 0 })).toContain(
    "Marked new, the widget shows a dot and your portal's Changelog tab says New to signed-in readers, until they see it.",
  );
});

test("while the project's email is paused, a draft says subscribers aren't emailed, not that nobody subscribed", () => {
  expect(sidebar({ published: false, emailedSubscribers: false, subscribersLeft: 0, emailPaused: true }, 0)).toContain(
    "Your project's email is paused, so subscribers aren't emailed.",
  );
});

test("an entry emailed from the tool it was imported from says so, not that it went to 0 subscribers", () => {
  const imported = { emailedSubscribers: true, subscribersLeft: 0, subscribersSent: 0, emailedFrom: "Featurebase" };
  expect(sidebar({ ...imported, published: true })).toContain("Emailed to your subscribers from Featurebase.");
  expect(sidebar({ ...imported, published: false })).toContain("Emailed to your subscribers from Featurebase: it isn't sent again.");
  expect(sidebar({ ...imported, published: true })).not.toContain("0 subscribers");
});
