import { prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";
import type { z } from "zod";

import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";

import { saveWidgetSettings } from "../widget";
import { call } from "./run";
import { getWidgetSettings, textColorOn, updateWidgetSettings } from "./widget";

let owner: TestUser;
let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  owner = await signUp();
  project = await createProject(owner);
});

const team = () => ({ actor: { kind: "user" as const, userId: owner.id }, projectId: project.id });
const update = (input: z.input<typeof updateWidgetSettings.input>) =>
  call(updateWidgetSettings, team(), input);

const DEFAULTS = { label: "Feedback", color: null, position: "bottom-right", links: [], icon: "chat", iconImage: null };

test("the launcher starts as the green chat bubble named Feedback, bottom right, without links", async () => {
  expect(await call(getWidgetSettings, team(), {})).toEqual(DEFAULTS);
});

test("the team sets the label, colour, corner and up to 5 https links; each change leaves the rest", async () => {
  const links = [
    { label: " Status ", url: " https://status.example.com " },
    { label: "Docs", url: "https://docs.example.com/start?from=widget" },
  ];
  expect(await update({ label: "  Help & ideas ", color: "#5B21B6", position: "bottom-left", links })).toEqual({
    label: "Help & ideas",
    color: "#5b21b6",
    position: "bottom-left",
    links: [
      { label: "Status", url: "https://status.example.com" },
      { label: "Docs", url: "https://docs.example.com/start?from=widget" },
    ],
    icon: "chat",
    iconImage: null,
  });
  expect(await update({ label: "Ideas" })).toMatchObject({ label: "Ideas", color: "#5b21b6", position: "bottom-left", links: [{ label: "Status" }, { label: "Docs" }] });
  // Picking the brand green (or null) is the default again, with its dark-mode shade.
  expect((await update({ color: "#12804a" })).color).toBeNull();
  expect((await update({ color: "#5b21b6" })).color).toBe("#5b21b6");
  expect((await update({ color: null })).color).toBeNull();
  expect((await update({ links: [] })).links).toEqual([]);
});

test("settings are checked: https links only, lengths, at most 5 links, a real colour and corner", async () => {
  const refused = async (input: Parameters<typeof update>[0], message: string) =>
    expect(update(input)).rejects.toMatchObject({ status: 400, message });
  const link = (url: string, label = "Status") => [{ label, url }];
  await refused({ links: link("http://status.example.com") }, "Links need a full https:// address");
  await refused({ links: link("javascript:alert(1)") }, "Links need a full https:// address");
  await refused({ links: link("status.example.com") }, "Links need a full https:// address");
  await refused({ links: link(`https://example.com/${"a".repeat(500)}`) }, "Keep links under 500 characters");
  await refused({ links: link("https://status.example.com", " ") }, "Give each link a label");
  await refused({ links: link("https://status.example.com", "a".repeat(41)) }, "Keep link labels under 40 characters");
  await refused({ links: Array(6).fill({ label: "Status", url: "https://status.example.com" }) }, "Add up to 5 links");
  await refused({ label: "  " }, "Give the button a label");
  await refused({ label: "a".repeat(31) }, "Keep the label under 30 characters");
  await refused({ color: "red" }, "Pick a colour like #12804a");
  await refused({ color: "#12804a; display: none" }, "Pick a colour like #12804a");
  await refused({ position: "top-left" as "bottom-left" }, "Pick bottom-right or bottom-left");
  await refused({ icon: "rocket" as "chat" }, "Pick chat, help, megaphone, lightbulb, image");
  await refused({ icon: "image" }, "Upload an image for the icon");
  // Nothing was saved.
  expect(await call(getWidgetSettings, team(), {})).toEqual(DEFAULTS);
});

test("the app's form saves the settings, skipping empty link rows and refusing half-filled ones", async () => {
  actAs(owner);
  const form = (rows: [string, string][]) => {
    const data = new FormData();
    data.set("label", "Help");
    data.set("color", "#5b21b6");
    data.set("position", "bottom-left");
    for (const [label, url] of rows) {
      data.append("linkLabel", label);
      data.append("linkUrl", url);
    }
    return data;
  };
  expect(await saveWidgetSettings(project.slug, {}, form([["Status", "https://status.example.com"], ["", " "]]))).toEqual({});
  expect(await call(getWidgetSettings, team(), {})).toEqual({
    label: "Help",
    color: "#5b21b6",
    position: "bottom-left",
    links: [{ label: "Status", url: "https://status.example.com" }],
    icon: "chat",
    iconImage: null,
  });
  // With the icon's fields (where the plan includes them), the icon too.
  const withIcon = form([]);
  withIcon.set("icon", "lightbulb");
  withIcon.set("iconImage", "");
  expect(await saveWidgetSettings(project.slug, {}, withIcon)).toEqual({});
  expect(await call(getWidgetSettings, team(), {})).toMatchObject({ icon: "lightbulb", iconImage: null });
  expect(await saveWidgetSettings(project.slug, {}, form([["Docs", ""]]))).toEqual({ error: "Links need a full https:// address" });
  expect(await saveWidgetSettings(project.slug, {}, form([["", "https://docs.example.com"]]))).toEqual({ error: "Give each link a label" });
});

test("the widget is a project setting: members can't change it, admins can", async () => {
  const form = () => {
    const data = new FormData();
    data.set("label", "Help");
    data.set("color", "#5b21b6");
    data.set("position", "bottom-left");
    return data;
  };
  actAs(await addMember(project.id, "MEMBER"));
  expect(await saveWidgetSettings(project.slug, {}, form())).toEqual({ error: "Only project owners and admins can change the widget" });
  expect(await call(getWidgetSettings, team(), {})).toMatchObject({ label: "Feedback", color: null });

  actAs(await addMember(project.id, "ADMIN"));
  expect(await saveWidgetSettings(project.slug, {}, form())).toEqual({});
  expect(await call(getWidgetSettings, team(), {})).toMatchObject({ label: "Help", color: "#5b21b6" });
});

test("links stored some other way never reach the widget unless they're valid", async () => {
  await prisma.project.update({
    where: { id: project.id },
    data: { widgetLinks: [{ label: "Bad", url: "javascript:alert(1)" }], widgetPosition: "top", widgetIcon: "rocket" },
  });
  expect(await call(getWidgetSettings, team(), {})).toMatchObject({ position: "bottom-right", links: [], icon: "chat" });
});

test("button text is black or white, whichever reads better on the colour", () => {
  expect(textColorOn("#12804a")).toBe("#ffffff");
  expect(textColorOn("#5b21b6")).toBe("#ffffff");
  expect(textColorOn("#facc15")).toBe("#000000");
  expect(textColorOn("#ffffff")).toBe("#000000");
});
