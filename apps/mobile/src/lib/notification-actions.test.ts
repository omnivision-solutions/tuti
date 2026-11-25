import type { NotificationResponse } from "expo-notifications";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The phone: its stored session, its files, the system's notifications and the server, all faked.
const phone = vi.hoisted(() => ({
  os: "ios" as "ios" | "android",
  appState: "active",
  stored: new Map<string, string>(),
  files: new Map<string, string>(),
  dismissed: [] as string[],
  shown: [] as { content: { title: string; body: string; data: unknown }; trigger: unknown }[],
  categories: [] as { id: string; actions: { identifier: string; options?: object; textInput?: object }[] }[],
  listener: null as ((response: unknown) => void) | null,
  last: null as unknown,
  task: null as ((body: { data: unknown }) => Promise<unknown>) | null,
  registered: [] as string[],
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return phone.os;
    },
  },
  AppState: {
    get currentState() {
      return phone.appState;
    },
  },
}));
vi.mock("expo-secure-store", () => ({ AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0, getItemAsync: async (key: string) => phone.stored.get(key) ?? null }));
vi.mock("expo-web-browser", () => ({}));
vi.mock("expo-constants", () => ({ default: {} }));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_: string, text: string) => Buffer.from(text).toString("hex").padEnd(64, "0"),
}));
vi.mock("expo-file-system", () => {
  const path = (parts: unknown[]) => parts.map((part) => (typeof part === "string" ? part : (part as { uri: string }).uri)).join("/");
  class File {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = path(parts);
    }
    get exists() {
      return phone.files.has(this.uri);
    }
    textSync() {
      return phone.files.get(this.uri)!;
    }
    writeSync(text: string) {
      phone.files.set(this.uri, text);
    }
  }
  class Directory extends File {
    create() {}
  }
  return { File, Directory, Paths: { document: "documents", cache: "cache" } };
});
vi.mock("expo-task-manager", () => ({ defineTask: (_: string, task: typeof phone.task) => void (phone.task = task) }));
vi.mock("expo-notifications", () => ({
  AndroidImportance: { HIGH: 4 },
  IosAuthorizationStatus: { PROVISIONAL: 3 },
  DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
  setNotificationCategoryAsync: async (id: string, actions: (typeof phone.categories)[number]["actions"]) => void phone.categories.push({ id, actions }),
  registerTaskAsync: async (name: string) => void phone.registered.push(name),
  addNotificationResponseReceivedListener: (listener: typeof phone.listener) => {
    phone.listener = listener;
    return { remove: () => {} };
  },
  getLastNotificationResponse: () => phone.last,
  dismissNotificationAsync: async (id: string) => void phone.dismissed.push(id),
  scheduleNotificationAsync: async (request: (typeof phone.shown)[number]) => void phone.shown.push(request),
}));

type Call = { url: string; method: string; project?: string; body?: unknown };
const calls: Call[] = [];
let answer: (call: Call) => Response = () => Response.json({});
vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
  const headers = init.headers as Record<string, string>;
  const call = { url, method: init.method ?? "GET", project: headers["tuti-project"], ...(init.body ? { body: JSON.parse(init.body as string) } : {}) };
  calls.push(call);
  return answer(call);
});

const SERVER = "https://tuti.example";
const signIn = (project = "acme") => phone.stored.set("session", JSON.stringify({ server: SERVER, token: "token-1", cookie: "c", project }));
const response = (actionIdentifier: string, { userText, project = "acme", id = "push-1" }: { userText?: string; project?: string; id?: string } = {}) =>
  ({
    actionIdentifier,
    ...(userText !== undefined && { userText }),
    notification: { date: 0, request: { identifier: id, trigger: null, content: { title: "Ada · Acme", body: "Hi", data: { project, conversation: 7 } } } },
  }) as unknown as NotificationResponse;

const load = () => import("./notification-actions");
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  vi.resetModules();
  Object.assign(phone, { os: "ios", appState: "active", dismissed: [], shown: [], categories: [], listener: null, last: null, task: null, registered: [] });
  phone.stored.clear();
  phone.files.clear();
  calls.length = 0;
  answer = () => Response.json({});
  signIn();
});

describe("the notification's actions", () => {
  it("are Reply, with text, and Close, neither opening the app, both only on an unlocked phone", async () => {
    (await load()).startNotificationActions();
    expect(phone.categories).toEqual([
      {
        id: "conversation",
        actions: [
          { identifier: "reply", buttonTitle: "Reply", textInput: { submitButtonTitle: "Send", placeholder: "Reply" }, options: { opensAppToForeground: false, isAuthenticationRequired: true } },
          { identifier: "close", buttonTitle: "Close", options: { opensAppToForeground: false, isAuthenticationRequired: true } },
        ],
      },
    ]);
  });
});

describe("Reply", () => {
  it("sends the reply in the notification's project, with an id from the notification and the text, then dismisses it", async () => {
    await (await load()).act(response("reply", { userText: "  On it!  " }));
    expect(calls).toEqual([
      {
        url: `${SERVER}/api/v1/conversations/7/messages`,
        method: "POST",
        project: "acme",
        body: { body: "On it!", requestId: `notification-${Buffer.from("push-1\nOn it!").toString("hex").padEnd(64, "0").slice(0, 40)}` },
      },
    ]);
    expect(phone.dismissed).toEqual(["push-1"]);
    expect(phone.shown).toEqual([]);
  });

  it("is sent once when the listener and the last response both tell of it", async () => {
    phone.last = response("reply", { userText: "On it!" });
    (await load()).startNotificationActions();
    phone.listener!(response("reply", { userText: "On it!" }));
    await settle();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("goes to another of the teammate's projects, never to one that isn't theirs", async () => {
    answer = (call) => (call.url.endsWith("/projects") ? Response.json({ projects: [{ slug: "acme" }, { slug: "globex" }] }) : Response.json({}));
    await (await load()).act(response("reply", { userText: "On it!", project: "globex" }));
    expect(calls.map((call) => [call.method, call.url, call.project])).toEqual([
      ["GET", `${SERVER}/api/v1/projects`, undefined],
      ["POST", `${SERVER}/api/v1/conversations/7/messages`, "globex"],
    ]);

    calls.length = 0;
    phone.dismissed = [];
    await (await load()).act(response("reply", { userText: "On it!", project: "initech", id: "push-2" }));
    expect(calls.map((call) => call.url)).toEqual([`${SERVER}/api/v1/projects`]);
    expect(phone.dismissed).toEqual([]);
    expect(phone.shown).toEqual([]);
  });

  it("does nothing signed out", async () => {
    phone.stored.clear();
    await (await load()).act(response("reply", { userText: "On it!" }));
    expect(calls).toEqual([]);
    expect(phone.dismissed).toEqual([]);
    expect(phone.shown).toEqual([]);
  });

  it("that didn't send is kept in the conversation with Retry, and a notification says so and opens it", async () => {
    answer = () => {
      throw new TypeError("Network request failed");
    };
    const { act } = await load();
    await act(response("reply", { userText: "On it!" }));
    expect(phone.dismissed).toEqual(["push-1"]);
    expect(phone.shown).toEqual([
      {
        content: {
          title: "Your reply didn't send",
          body: "Ada · Acme: Couldn't reach tuti.example. Check the address and your connection. It's kept in the conversation, with Retry.",
          data: { project: "acme", conversation: 7 },
        },
        trigger: null,
      },
    ]);
    const { getDraft } = await import("./conversation");
    const { screenKey } = await import("./details");
    const draft = getDraft(screenKey({ server: SERVER, project: "acme" }, 7));
    expect(draft.unsent).toEqual([
      expect.objectContaining({ id: calls[0]!.body && (calls[0]!.body as { requestId: string }).requestId, body: "On it!", note: false, error: expect.stringContaining("Couldn't reach") }),
    ]);
  });
});

describe("Close", () => {
  it("closes the conversation and dismisses the notification", async () => {
    await (await load()).act(response("close"));
    expect(calls).toEqual([{ url: `${SERVER}/api/v1/conversations/7`, method: "PATCH", project: "acme", body: { status: "closed" } }]);
    expect(phone.dismissed).toEqual(["push-1"]);
  });

  it("that failed leaves a notification in the server's words, on Android's channel", async () => {
    phone.os = "android";
    answer = () => Response.json({ error: { code: "forbidden", message: "You can't change this conversation." } }, { status: 403 });
    await (await load()).act(response("close"));
    expect(phone.shown).toEqual([
      {
        content: { title: "Couldn't close the conversation", body: "Ada · Acme: You can't change this conversation.", data: { project: "acme", conversation: 7 } },
        trigger: { channelId: "default" },
      },
    ]);
  });
});

describe("on Android", () => {
  it("acts from the background task when the app isn't in front, and not from the listener as well", async () => {
    phone.os = "android";
    phone.appState = "background";
    (await load()).startNotificationActions();
    expect(phone.registered).toEqual(["notification-action"]);
    phone.listener!(response("close"));
    await settle();
    expect(calls).toEqual([]);
    // Also run for every push received: only an action is acted on.
    await phone.task!({ data: { notification: {}, data: {} } });
    expect(calls).toEqual([]);
    await phone.task!({ data: response("close") });
    expect(calls.map((call) => call.method)).toEqual(["PATCH"]);
  });

  it("acts from the listener while the app is in front", async () => {
    phone.os = "android";
    (await load()).startNotificationActions();
    phone.listener!(response("close"));
    await settle();
    expect(calls.map((call) => call.method)).toEqual(["PATCH"]);
  });
});
