import { expect, test, vi } from "vitest";

import { widgetLoader } from "./widget-loader";

test("the loader is valid JavaScript with the portal template and the slug check built in", () => {
  const script = widgetLoader("https://{project}.tuti.example");
  expect(() => new Function(script)).not.toThrow();
  expect(script).toContain('"https://{project}.tuti.example".replace("{project}", slug)');
  expect(script).toContain("/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)");
  // Text goes in with textContent; nothing builds HTML from strings.
  expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
});

test("sign-in tokens go to the panel only, on the portal's origin, when it asks", () => {
  const script = widgetLoader("https://{project}.tuti.example");
  // postMessage to the frame names its origin; never "*" for a token.
  expect(script).toMatch(/target\.postMessage\(\{ type: "tuti:identify", token: token \}, origin\)/);
  expect(script).not.toMatch(/postMessage\([^)]*token[^)]*"\*"\)/);
  // Messages count only from the panel's own window and origin.
  expect(script).toContain("if (!event.source || event.origin !== origin) return;");
  expect(script).toContain("if (frames[i].contentWindow === event.source) from = frames[i];");
});

/** Just enough DOM to run the loader: elements with attributes, styles, children and bubbling clicks. */
class FakeElement {
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: unknown[] = [];
  parent: FakeElement | null = null;
  listeners: Record<string, ((event: object) => void)[]> = {};
  [property: string]: unknown;
  constructor(
    readonly tagName: string,
    private readonly page: FakePage,
  ) {}
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  appendChild<T>(child: T) {
    if (child instanceof FakeElement) child.parent = this;
    this.children.push(child);
    return child;
  }
  addEventListener(type: string, listener: (event: object) => void) {
    (this.listeners[type] ??= []).push(listener);
  }
  focus() {
    this.page.document.activeElement = this;
  }
  closest(selector: string) {
    const name = /^\[([\w-]+)\]$/.exec(selector)![1]!;
    return this.ancestors().find((element) => element.hasAttribute(name)) ?? null;
  }
  /** This element, its parent, and so on up. */
  ancestors(): FakeElement[] {
    return [this, ...(this.parent?.ancestors() ?? [])];
  }
  get text() {
    return this.children.map((child) => (child as { nodeValue?: string }).nodeValue ?? "").join("");
  }
  /** A click that bubbles up to the document (with modifier keys, or already cancelled, from `init`); says whether the default was prevented. */
  click(init: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; defaultPrevented?: boolean } = {}) {
    const event = { button: 0, ...init, target: this, defaultPrevented: init.defaultPrevented ?? false, preventDefault: () => (event.defaultPrevented = true) };
    for (const element of this.ancestors()) {
      element.listeners.click?.forEach((listener) => listener(event));
    }
    this.page.documentListeners.click?.forEach((listener) => listener(event));
    return event.defaultPrevented;
  }
}

type FakePage = ReturnType<typeof loadWidget>;

/**
 * Runs the loader on a fake page whose script tag has `attributes`, with /api/widget/latest answering
 * `latest`, /api/widget/seen answering `seen` and this browser having seen announcements up to `seenHere`.
 */
function loadWidget({ attributes = {}, settings, latest = { latest: null, launcher: null }, seen = null, seenHere, narrow = false, before }: {
  attributes?: Record<string, string>;
  settings?: object;
  /** Whether the screen is narrow (max-width: 640px). */
  narrow?: boolean;
  /** Builds the page's own elements before the script runs. */
  before?: (page: FakePage) => void;
  /** null: the request fails; "hang": it never answers. */
  latest?: object | null | "hang";
  /** What this person has seen on any device; "fail": the request fails. */
  seen?: string | null | "fail";
  seenHere?: string;
}) {
  const documentListeners: Record<string, ((event: object) => void)[]> = {};
  const windowListeners: Record<string, ((event: object) => void)[]> = {};
  const stored = new Map<string, string>(seenHere ? [["tuti:seen:acme", seenHere]] : []);
  const mediaLists: { matches: boolean; onchange: (() => void) | null }[] = [];
  const observers: (() => void)[] = [];
  const page = {
    documentListeners,
    windowListeners,
    mediaLists,
    /** The page changed: what MutationObserver tells the script. */
    mutated() {
      observers.forEach((callback) => callback());
    },
    /** The screen becomes narrow or wide. */
    resize(narrow: boolean) {
      for (const list of mediaLists.filter((list) => list.onchange)) {
        list.matches = narrow;
        list.onchange!();
      }
    },
    /** A key pressed on the page. */
    press(key: string) {
      documentListeners.keydown?.forEach((listener) => listener({ key }));
    },
    /** A message from `source` (a window) on `origin`. */
    message(source: unknown, data: unknown, origin = "https://acme.tuti.example") {
      windowListeners.message?.forEach((listener) => listener({ source, origin, data }));
    },
    get backdrop() {
      return page.body.children.find((child) => (child as FakeElement).tagName === "div" && (child as FakeElement).id !== "tuti-widget") as
        | FakeElement
        | undefined;
    },
    /** The page's inline panels. */
    get inlineFrames() {
      return page.document.querySelectorAll("[data-tuti-inline]").flatMap((element) => element.children as FakeElement[]);
    },
    document: {
      activeElement: null as unknown,
      body: null as unknown as FakeElement,
      currentScript: null as unknown as FakeElement,
      createElement: (tag: string) => {
        const element = new FakeElement(tag, page);
        // An iframe's window, for messages to and from it.
        if (tag === "iframe") element.contentWindow = { postMessage: vi.fn() };
        return element;
      },
      createTextNode: (text: string) => ({ nodeValue: text }),
      querySelectorAll: (selector: string) => {
        const name = /^\[([\w-]+)\]$/.exec(selector)![1]!;
        const all = (element: FakeElement): FakeElement[] =>
          element.children.flatMap((child) => (child instanceof FakeElement ? [child, ...all(child)] : []));
        return all(page.document.body).filter((element) => element.hasAttribute(name));
      },
      addEventListener: (type: string, listener: (event: object) => void) => (documentListeners[type] ??= []).push(listener),
      contains: (element: FakeElement) => {
        for (let e: FakeElement | null = element; e; e = e.parent) if (e === page.document.body) return true;
        return false;
      },
    },
    window: {
      TutiSettings: settings,
      matchMedia: (query: string) => {
        const list = { matches: narrow && query === "(max-width: 640px)", onchange: null as (() => void) | null };
        mediaLists.push(list);
        return list;
      },
      MutationObserver: class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe() {}
      },
      localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
      addEventListener: (type: string, listener: (event: object) => void) => (windowListeners[type] ??= []).push(listener),
      fetch: vi.fn(async (url: string) => {
        if (url.startsWith("https://app.tuti.example/api/widget/seen?")) {
          if (seen === "fail") throw new TypeError("Failed to fetch");
          return { ok: true, json: async () => ({ seen }) };
        }
        if (latest === "hang") return new Promise(() => {});
        if (!latest) throw new TypeError("Failed to fetch");
        return { ok: true, json: async () => latest };
      }),
    } as Record<string, unknown>,
    get body() {
      return page.document.body;
    },
    get button() {
      return page.body.children.find((child) => (child as FakeElement).tagName === "button") as FakeElement | undefined;
    },
    get panel() {
      return page.body.children.find((child) => (child as FakeElement).id === "tuti-widget") as FakeElement;
    },
    get frame() {
      return page.panel.children[0] as FakeElement | undefined;
    },
    /** Calls to /api/widget/seen. */
    get seenRequests() {
      return (page.window.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => String(url).includes("/api/widget/seen"));
    },
    get stored() {
      return stored;
    },
    /** The panel saying the visitor has seen announcements up to `at`. */
    seen(at: string) {
      page.windowListeners.message?.forEach((listener) =>
        listener({ source: (page.frame as unknown as { contentWindow?: unknown }).contentWindow, origin: "https://acme.tuti.example", data: { type: "tuti:seen", at } }),
      );
    },
    get Tuti() {
      return page.window.Tuti as {
        identify(getToken: () => unknown): void;
        open(options?: object): void;
        close(): void;
        unseen(): boolean;
        on(name: string, callback: (unseen: boolean) => void): void;
      };
    },
  };
  page.document.body = new FakeElement("body", page);
  const script = new FakeElement("script", page);
  script.src = "https://app.tuti.example/widget.js";
  script.setAttribute("data-project", "acme");
  for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
  page.document.currentScript = script;
  before?.(page);
  new Function("window", "document", "fetch", widgetLoader("https://{project}.tuti.example"))(
    page.window,
    page.document,
    page.window.fetch,
  );
  return page;
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the launcher shows the team's label, colour and corner once the app has said what they are", async () => {
  const page = loadWidget({
    latest: { latest: null, launcher: { label: "Help & ideas", color: "#5b21b6", textColor: "#ffffff", position: "bottom-left" } },
  });
  expect(page.window.fetch).toHaveBeenCalledWith("https://app.tuti.example/api/widget/latest?project=acme");
  // Not before, so it doesn't change under the visitor's pointer.
  expect(page.button).toBeUndefined();
  await settled();
  const button = page.button!;
  expect(button.text).toBe("Help & ideas");
  expect(button.getAttribute("aria-label")).toBe("Help & ideas");
  expect(button.style).toMatchObject({ background: "#5b21b6", color: "#ffffff", left: "20px", right: "auto" });
  expect(page.panel.style).toMatchObject({ left: "20px", right: "auto" });
});

test("without settings (or without an answer) the launcher is the green Feedback button, bottom right", async () => {
  for (const latest of [{ latest: null, launcher: null }, null]) {
    const page = loadWidget({ latest });
    await settled();
    expect(page.button!.text).toBe("Feedback");
    expect(page.button!.style).toMatchObject({ right: "20px", background: "oklch(0.529 0.125 155)" });
    expect(page.Tuti.unseen()).toBe(false);
  }
});

test("if the app doesn't answer, the button shows up after 3 seconds anyway", () => {
  vi.useFakeTimers();
  try {
    const page = loadWidget({ latest: "hang" });
    vi.advanceTimersByTime(2999);
    expect(page.button).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(page.button!.text).toBe("Feedback");
  } finally {
    vi.useRealTimers();
  }
});

test("data-hide-launcher or TutiSettings.hideLauncher leaves the button out; Tuti.open() and Tuti.close() still work", async () => {
  for (const page of [loadWidget({ attributes: { "data-hide-launcher": "" } }), loadWidget({ settings: { hideLauncher: true } })]) {
    await settled();
    expect(page.button).toBeUndefined();
    // The panel takes the button's place.
    expect(page.panel.style.bottom).toBe("20px");
    const own = page.body.appendChild(new FakeElement("button", page));
    own.focus();
    page.Tuti.open();
    expect(page.panel.style.display).toBe("block");
    expect(page.frame!.src).toBe("https://acme.tuti.example/widget");
    page.Tuti.close();
    expect(page.panel.style.display).toBe("none");
    // Focus goes back to the page's own button.
    expect(page.document.activeElement).toBe(own);
  }
});

test("Tuti.open({ tab }) opens the panel at that tab, Tuti.open() where it was; unknown tabs are reported", async () => {
  const page = loadWidget({});
  page.Tuti.open({ tab: "whats-new" });
  expect(page.frame!.src).toBe("https://acme.tuti.example/widget?tab=whats-new");
  page.Tuti.open({ tab: "help" });
  expect(page.frame!.src).toBe("https://acme.tuti.example/widget?tab=help");
  page.Tuti.open();
  expect(page.frame!.src).toBe("https://acme.tuti.example/widget?tab=help");
  page.Tuti.open({ tab: "feedback" });
  expect(page.frame!.src).toBe("https://acme.tuti.example/widget");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  page.Tuti.open({ tab: "settings" });
  expect(error).toHaveBeenCalledWith("Tuti widget: tab is one of feedback, whats-new or help");
  expect(page.frame!.src).toBe("https://acme.tuti.example/widget");
  error.mockRestore();
});

test("Tuti.open({ article }) and data-tuti-article elements, also ones added later, open the panel at that article", async () => {
  const page = loadWidget({});
  page.Tuti.open({ article: "a b/c" });
  expect(page.frame!.src).toBe("https://acme.tuti.example/widget?tab=help&article=a%20b%2Fc");
  page.Tuti.close();

  // A help link added after the script ran, clicked on its icon: no navigation, the article opens.
  const help = page.body.appendChild(new FakeElement("a", page));
  help.setAttribute("data-tuti-article", "exporting-your-data");
  const icon = help.appendChild(new FakeElement("svg", page));
  expect(icon.click()).toBe(true);
  expect(page.panel.style.display).toBe("block");
  expect(page.frame!.src).toBe("https://acme.tuti.example/widget?tab=help&article=exporting-your-data");
  // Closing gives focus back to it.
  page.Tuti.close();
  expect(page.document.activeElement).toBe(help);

  // Other clicks are the page's own.
  expect(page.body.appendChild(new FakeElement("button", page)).click()).toBe(false);
  expect(page.panel.style.display).toBe("none");
  // So are a help link's clicks with a modifier key (new tab, new window, download) or that the page already handled.
  for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }]) {
    expect(help.click(init)).toBe(false);
  }
  help.click({ defaultPrevented: true });
  expect(page.panel.style.display).toBe("none");
});

test("Tuti.unseen() and Tuti.on('unseen') tell the page about an announcement this browser hasn't seen", async () => {
  const page = loadWidget({ latest: { latest: "2026-10-18T10:00:00.000Z", launcher: null } });
  const calls: boolean[] = [];
  page.Tuti.on("unseen", (unseen) => calls.push(unseen));
  expect(page.Tuti.unseen()).toBe(false);
  expect(calls).toEqual([]);
  await settled();
  expect(page.Tuti.unseen()).toBe(true);
  expect(calls).toEqual([true]);
  expect(page.button!.getAttribute("aria-label")).toBe("Feedback, new updates");
  // A callback added later hears the status straight away; a failing one doesn't stop the others.
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  page.Tuti.on("unseen", () => {
    throw new Error("page bug");
  });
  const late: boolean[] = [];
  page.Tuti.on("unseen", (unseen) => late.push(unseen));
  expect(late).toEqual([true]);
  error.mockRestore();
});

test("the panel saying it showed an older announcement doesn't hide a newer one", async () => {
  const page = loadWidget({ latest: { latest: "2026-10-18T10:00:00.000Z", launcher: null } });
  await settled();
  page.Tuti.open({ tab: "whats-new" });
  const seen = (at: string) =>
    page.windowListeners.message?.forEach((listener) =>
      listener({ source: (page.frame as unknown as { contentWindow?: unknown }).contentWindow, origin: "https://acme.tuti.example", data: { type: "tuti:seen", at } }),
    );
  // The panel was rendered before the newest announcement was published.
  seen("2026-10-17T10:00:00.000Z");
  expect(page.Tuti.unseen()).toBe(true);
  seen("2026-10-18T10:00:00.000Z");
  expect(page.Tuti.unseen()).toBe(false);
});

test("an announcement this browser has seen isn't unseen", async () => {
  const page = loadWidget({ latest: { latest: "2026-10-18T10:00:00.000Z", launcher: null } });
  (page.window.localStorage as { setItem(key: string, value: string): void }).setItem("tuti:seen:acme", "2026-10-18T10:00:00.000Z");
  const calls: boolean[] = [];
  page.Tuti.on("unseen", (unseen) => calls.push(unseen));
  await settled();
  expect(page.Tuti.unseen()).toBe(false);
  expect(calls).toEqual([false]);
});

const token = () => Promise.resolve("sso-token");
const LATEST = { latest: "2026-10-18T10:00:00.000Z", launcher: null };

test("someone the page signs in who saw the announcement on another device doesn't see it as new here; this browser remembers", async () => {
  const page = loadWidget({ settings: { identify: token }, latest: LATEST, seen: "2026-10-19T08:00:00.000Z", seenHere: "2026-10-01T00:00:00.000Z" });
  const calls: boolean[] = [];
  page.Tuti.on("unseen", (unseen) => calls.push(unseen));
  await settled();
  // Worked out once, with what they've seen anywhere: no dot that comes and goes.
  expect(calls).toEqual([false]);
  expect(page.Tuti.unseen()).toBe(false);
  expect(page.seenRequests).toEqual([
    ["https://app.tuti.example/api/widget/seen?project=acme", { headers: { authorization: "Bearer sso-token" } }],
  ]);
  // The later of the two times.
  expect(page.stored.get("tuti:seen:acme")).toBe("2026-10-19T08:00:00.000Z");
});

test("the later of this browser's time and the person's counts; without a newer one, it's still new", async () => {
  const page = loadWidget({ settings: { identify: token }, latest: LATEST, seen: "2026-10-01T00:00:00.000Z", seenHere: "2026-10-05T00:00:00.000Z" });
  await settled();
  expect(page.Tuti.unseen()).toBe(true);
  expect(page.stored.get("tuti:seen:acme")).toBe("2026-10-05T00:00:00.000Z");
});

test("nobody signed in, or seen in this browser already: no request about the person", async () => {
  const anonymous = loadWidget({ latest: LATEST });
  const seenHere = loadWidget({ settings: { identify: token }, latest: LATEST, seenHere: "2026-10-18T10:00:00.000Z" });
  await settled();
  expect(anonymous.Tuti.unseen()).toBe(true);
  expect(seenHere.Tuti.unseen()).toBe(false);
  expect([...anonymous.seenRequests, ...seenHere.seenRequests]).toEqual([]);
});

test("if the person's time can't be read (no token, or the request fails), this browser's counts", async () => {
  const failed = loadWidget({ settings: { identify: token }, latest: LATEST, seen: "fail" });
  const noToken = loadWidget({ settings: { identify: () => null }, latest: LATEST, seen: "2026-10-19T08:00:00.000Z" });
  await settled();
  expect(failed.Tuti.unseen()).toBe(true);
  expect(noToken.Tuti.unseen()).toBe(true);
  expect(noToken.seenRequests).toEqual([]);
});

test("signed in after the status was worked out (Tuti.identify), it's checked again", async () => {
  const page = loadWidget({ latest: LATEST, seen: "2026-10-19T08:00:00.000Z" });
  const calls: boolean[] = [];
  page.Tuti.on("unseen", (unseen) => calls.push(unseen));
  await settled();
  expect(page.Tuti.unseen()).toBe(true);
  page.Tuti.identify(token);
  await settled();
  expect(page.Tuti.unseen()).toBe(false);
  expect(calls).toEqual([true, false]);
});

test("when the panel shows the announcement, it's recorded for the person, so their other devices know", async () => {
  const page = loadWidget({ settings: { identify: token }, latest: LATEST, seen: null });
  await settled();
  expect(page.Tuti.unseen()).toBe(true);
  page.Tuti.open({ tab: "whats-new" });
  page.seen("2026-10-18T10:00:00.000Z");
  expect(page.Tuti.unseen()).toBe(false);
  await settled();
  expect(page.seenRequests.at(-1)).toEqual([
    "https://app.tuti.example/api/widget/seen?project=acme",
    {
      method: "POST",
      headers: { authorization: "Bearer sso-token", "content-type": "application/json" },
      body: JSON.stringify({ at: "2026-10-18T10:00:00.000Z" }),
    },
  ]);
  // Not for visitors the page doesn't sign in.
  const anonymous = loadWidget({ latest: LATEST });
  await settled();
  anonymous.Tuti.open({ tab: "whats-new" });
  anonymous.seen("2026-10-18T10:00:00.000Z");
  await settled();
  expect(anonymous.seenRequests).toEqual([]);
});

test("by default the panel opens above the launcher, as before: no drawer, no backdrop", async () => {
  const page = loadWidget({ narrow: true });
  await settled();
  page.button!.click();
  expect(page.panel.style).toMatchObject({ display: "block", right: "20px", bottom: "76px", borderRadius: "14px" });
  expect(page.panel.style.top).toBeUndefined();
  expect(page.backdrop).toBeUndefined();
  expect(page.inlineFrames).toEqual([]);
});

test("data-display or TutiSettings.display picks the mode, the attribute first; an unknown one is reported and it's the launcher", async () => {
  const sidebar = (page: FakePage) => page.panel.style.top === "0";
  expect(sidebar(loadWidget({ attributes: { "data-display": "sidebar" } }))).toBe(true);
  expect(sidebar(loadWidget({ settings: { display: "sidebar" } }))).toBe(true);
  expect(sidebar(loadWidget({ attributes: { "data-display": "launcher" }, settings: { display: "sidebar" } }))).toBe(false);

  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const unknown = loadWidget({ attributes: { "data-display": "popup" } });
  expect(error).toHaveBeenCalledWith("Tuti widget: display is one of launcher, sidebar or inline");
  error.mockRestore();
  await settled();
  expect(sidebar(unknown)).toBe(false);
  expect(unknown.button!.text).toBe("Feedback");
});

test("sidebar: a full-height drawer on the launcher's side; Escape closes it and focus goes back to the button", async () => {
  const page = loadWidget({ attributes: { "data-display": "sidebar" } });
  await settled();
  const button = page.button!;
  expect(page.panel.style).toMatchObject({ display: "none", top: "0", bottom: "0", right: "0", width: "min(400px, 100vw)" });
  // Over the launcher, which sits in the same corner.
  expect(Number(page.panel.style.zIndex)).toBeGreaterThan(Number(button.style.zIndex));
  button.focus();
  button.click();
  expect(page.panel.style.display).toBe("block");
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(page.document.activeElement).toBe(page.frame);
  // Wide screen: the page stays usable beside it.
  expect(page.backdrop!.style.display).toBe("none");
  page.press("Escape");
  expect(page.panel.style.display).toBe("none");
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(page.document.activeElement).toBe(button);

  // On the left with a bottom-left launcher.
  const left = loadWidget({ attributes: { "data-display": "sidebar" }, latest: { latest: null, launcher: { position: "bottom-left" } } });
  await settled();
  expect(left.panel.style).toMatchObject({ left: "0", right: "auto" });
});

test("sidebar on a narrow screen: a backdrop that closes the drawer, also after the screen changes", async () => {
  const page = loadWidget({ attributes: { "data-display": "sidebar" }, narrow: true });
  await settled();
  const button = page.button!;
  button.click();
  expect(page.backdrop!.style.display).toBe("block");
  // Under the drawer, over the page.
  expect(page.body.children.indexOf(page.backdrop)).toBeLessThan(page.body.children.indexOf(page.panel));
  page.backdrop!.click();
  expect(page.panel.style.display).toBe("none");
  expect(page.backdrop!.style.display).toBe("none");
  expect(page.document.activeElement).toBe(button);

  // Turned to landscape while open, and back.
  page.Tuti.open();
  page.resize(false);
  expect(page.backdrop!.style.display).toBe("none");
  page.resize(true);
  expect(page.backdrop!.style.display).toBe("block");
  // A closed drawer leaves no backdrop behind.
  page.Tuti.close();
  page.resize(false);
  page.resize(true);
  expect(page.backdrop!.style.display).toBe("none");
});

/** A data-tuti-inline element on the page, naming `tab` (empty: the default), with other `attributes`. */
function inlineMount(page: FakePage, tab = "", attributes: Record<string, string> = {}) {
  const element = page.body.appendChild(new FakeElement("div", page));
  element.setAttribute("data-tuti-inline", tab);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

test("inline: each data-tuti-inline element gets its own panel, at the tab it names, without a close button", async () => {
  const page = loadWidget({
    attributes: { "data-display": "inline" },
    before: (page) => {
      inlineMount(page);
      inlineMount(page, "help");
      // The page's own data-tab (its own tabs, say) is none of the widget's business.
      inlineMount(page, "", { "data-tab": "whats-new" });
    },
  });
  await settled();
  // No launcher in inline mode.
  expect(page.button).toBeUndefined();
  expect(page.inlineFrames.map((frame) => frame.src)).toEqual([
    "https://acme.tuti.example/widget?display=inline",
    "https://acme.tuti.example/widget?tab=help&display=inline",
    "https://acme.tuti.example/widget?display=inline",
  ]);
  for (const frame of page.inlineFrames) {
    expect(frame).toMatchObject({ tagName: "iframe", name: "tuti-inline", title: "Feedback" });
    expect(frame.style).toMatchObject({ width: "100%", height: "100%", minHeight: "500px", border: "0" });
  }
  // The floating panel is still there for Tuti.open().
  page.Tuti.open({ tab: "whats-new" });
  expect(page.frame!.src).toBe("https://acme.tuti.example/widget?tab=whats-new");
  expect(page.inlineFrames).toHaveLength(3);
});

test("inline mounts work in every mode, also ones added later, each mounted once; an unknown tab is reported, and it's the default", async () => {
  const page = loadWidget({ before: (page) => void inlineMount(page, "whats-new") });
  await settled();
  expect(page.button!.text).toBe("Feedback");
  expect(page.inlineFrames.map((frame) => frame.src)).toEqual(["https://acme.tuti.example/widget?tab=whats-new&display=inline"]);

  // A single-page app shows one later.
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  inlineMount(page, "settings");
  page.mutated();
  page.mutated();
  expect(error).toHaveBeenCalledWith("Tuti widget: tab is one of feedback, whats-new or help");
  error.mockRestore();
  expect(page.inlineFrames.map((frame) => frame.src)).toEqual([
    "https://acme.tuti.example/widget?tab=whats-new&display=inline",
    "https://acme.tuti.example/widget?display=inline",
  ]);
});

test("inline panels get sign-in tokens and say what's been seen; they can't close the floating panel", async () => {
  const page = loadWidget({ settings: { identify: token }, latest: LATEST, before: (page) => void inlineMount(page) });
  await settled();
  const inline = page.inlineFrames[0]!;
  const frameWindow = inline.contentWindow as { postMessage: ReturnType<typeof vi.fn> };
  page.message(frameWindow, { type: "tuti:ready" });
  await settled();
  expect(frameWindow.postMessage).toHaveBeenCalledWith({ type: "tuti:identify", token: "sso-token" }, "https://acme.tuti.example");

  // Only from the portal's origin, and only from the script's own frames.
  page.message(frameWindow, { type: "tuti:seen", at: LATEST.latest }, "https://evil.example");
  page.message({ postMessage: vi.fn() }, { type: "tuti:seen", at: LATEST.latest });
  expect(page.Tuti.unseen()).toBe(true);
  page.message(frameWindow, { type: "tuti:seen", at: LATEST.latest });
  expect(page.Tuti.unseen()).toBe(false);

  page.Tuti.open();
  page.message(frameWindow, "tuti:close");
  expect(page.panel.style.display).toBe("block");
  page.message(page.frame!.contentWindow, "tuti:close");
  expect(page.panel.style.display).toBe("none");

  // One the page has removed is forgotten.
  const mount = inline.parent!;
  page.body.children.splice(page.body.children.indexOf(mount), 1);
  mount.parent = null;
  page.mutated();
  page.message(frameWindow, { type: "tuti:ready" });
  await settled();
  expect(frameWindow.postMessage).toHaveBeenCalledTimes(1);
});
