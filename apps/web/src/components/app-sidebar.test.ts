import { InboxIcon, LightbulbIcon } from "lucide-react";
import { expect, test } from "vitest";

import { phoneTabs, type ProjectSummary } from "./app-sidebar";

const acme: ProjectSummary = { slug: "acme", name: "Acme", role: "OWNER", portalUrl: "https://acme.example.com", logo: null, logoDark: null, openConversations: 4, toTriage: 0, changesWaiting: 0 };
const open = (pathname: string, params: Record<string, string> = {}) => {
  const bar = phoneTabs(acme, pathname, { project: "acme", ...params });
  return bar && (bar.open?.title ?? "More");
};

test("the phone tab bar has Home, Inbox, Feedback and Autopilot, with their counts", () => {
  expect(phoneTabs(acme, "/app/acme", { project: "acme" })?.tabs.map((tab) => tab.title)).toEqual(["Home", "Inbox", "Feedback", "Autopilot"]);
  expect(phoneTabs(acme, "/app/acme", { project: "acme" })?.tabs[1]?.badge).toEqual({ count: 4, label: "open", urgent: true });
});

// The same items make the rail and the menu: the Inbox's tray, Feedback's lightbulb (as the widget's Feedback tab).
test("Inbox has the inbox tray and Feedback the lightbulb", () => {
  const tabs = phoneTabs(acme, "/app/acme", { project: "acme" })?.tabs;
  expect(tabs?.find((tab) => tab.title === "Inbox")?.icon).toBe(InboxIcon);
  expect(tabs?.find((tab) => tab.title === "Feedback")?.icon).toBe(LightbulbIcon);
});

test("the phone tab bar is on a part's own page, its tab open; More's parts open More", () => {
  expect(open("/app/acme")).toBe("Home");
  expect(open("/app/acme/inbox")).toBe("Inbox");
  expect(open("/app/acme/feedback")).toBe("Feedback");
  expect(open("/app/acme/feedback/roadmap")).toBe("Feedback");
  expect(open("/app/acme/feedback/boards")).toBe("Feedback");
  expect(open("/app/acme/autopilot/activity")).toBe("Autopilot");
  expect(open("/app/acme/autopilot")).toBe("Autopilot");
  expect(open("/app/acme/changelog")).toBe("More");
  expect(open("/app/acme/settings")).toBe("More");
});

test("a page of one thing, a new one and a setting have the screen to themselves: no phone tab bar", () => {
  expect(open("/app/acme/p/12", { number: "12" })).toBeNull();
  expect(open("/app/acme/inbox/4", { number: "4" })).toBeNull();
  expect(open("/app/acme/autopilot/c1", { id: "c1" })).toBeNull();
  expect(open("/app/acme/docs/getting-started", { slug: "getting-started" })).toBeNull();
  expect(open("/app/acme/changelog/new")).toBeNull();
  expect(open("/app/acme/docs/new")).toBeNull();
  expect(open("/app/acme/docs/getting-started/history", { slug: "getting-started" })).toBeNull();
  expect(open("/app/acme/settings/team")).toBeNull();
  expect(open("/app/acme/docs/collections/guides/settings", { collection: "guides" })).toBeNull();
  expect(open("/app/acme/settings/branding")).toBeNull();
});

test("Docs keeps its own phone navigation: no tab bar on any of its pages", () => {
  expect(open("/app/acme/docs")).toBeNull();
  expect(open("/app/acme/docs/collections/guides", { collection: "guides" })).toBeNull();
  expect(open("/app/acme/docs/tabs/settings", { tab: "settings" })).toBeNull();
  expect(open("/app/acme/docs/insights")).toBeNull();
});

test("a slug the team picks is never taken for a route", () => {
  const settings = { ...acme, slug: "settings" };
  expect(phoneTabs(settings, "/app/settings/feedback", { project: "settings" })?.open?.title).toBe("Feedback");
  expect(phoneTabs(settings, "/app/settings/inbox", { project: "settings" })?.open?.title).toBe("Inbox");
  expect(phoneTabs(settings, "/app/settings/settings/team", { project: "settings" })).toBeNull();
});
