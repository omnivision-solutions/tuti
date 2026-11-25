import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";

import { cached, cacheGeneration, keep, startCache } from "@/lib/offline";
import { SessionProvider, useSession } from "@/lib/session";

// Secure storage in memory, each write held until the test lets it land.
const mockStored = new Map<string, string>();
const mockWrites: (() => void)[] = [];
jest.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => mockStored.get(key) ?? null,
  setItemAsync: (key: string, value: string) => new Promise<void>((resolve) => mockWrites.push(() => (mockStored.set(key, value), resolve()))),
  deleteItemAsync: async (key: string) => void mockStored.delete(key),
}));
// What's on the lock screen, taken off on signing out (never waited for: this one never answers).
const mockDismissed = jest.fn(() => new Promise<void>(() => {}));
jest.mock("expo-notifications", () => ({ ...jest.requireActual<object>("expo-notifications"), dismissAllNotificationsAsync: () => mockDismissed() }));
// The phone's id for its notifications, as the first sign-out makes it up.
jest.mock("expo-crypto", () => ({ randomUUID: () => "phone-1" }));
// The server says the session holds, and takes the sign-out.
globalThis.fetch = jest.fn(async () => new Response("{}")) as unknown as typeof fetch;

const session = { server: "https://tuti.example.com", token: "token-1", cookie: "c", project: "acme" };
const storedProject = () => (JSON.parse(mockStored.get("session") ?? "null") as { project?: string } | null)?.project;

/** Lets every write waiting so far land, newest first, until none are left. */
async function landWrites() {
  while (mockWrites.length) {
    await act(async () => mockWrites.splice(0).reverse().forEach((land) => land()));
  }
}

function Harness() {
  const { session, setProject, signOut, signIn, api } = useSession();
  return (
    <>
      <Text testID="project">{session === null ? "signed out" : (session?.project ?? "")}</Text>
      <Pressable onPress={() => void setProject("kite").catch(() => {})}>
        <Text>Kite</Text>
      </Pressable>
      <Pressable onPress={() => void setProject("orbit").catch(() => {})}>
        <Text>Orbit</Text>
      </Pressable>
      <Pressable onPress={() => void signOut()}>
        <Text>Sign out</Text>
      </Pressable>
      <Pressable onPress={() => void signIn({ server: "https://tuti.example.com", token: "token-2", cookie: "c2" })}>
        <Text>Sign in</Text>
      </Pressable>
      <Pressable onPress={() => void api?.("/projects").catch(() => {})}>
        <Text>Call</Text>
      </Pressable>
    </>
  );
}

afterEach(() => {
  mockStored.clear();
  mockWrites.length = 0;
});

describe("choosing a project", () => {
  it("keeps the latest choice, however the saves land", async () => {
    mockStored.set("session", JSON.stringify(session));
    await render(
      <SessionProvider>
        <Harness />
      </SessionProvider>,
    );
    expect(await screen.findByText("acme")).toBeTruthy();

    await fireEvent.press(screen.getByText("Kite"));
    await fireEvent.press(screen.getByText("Orbit"));
    await landWrites();

    expect(screen.getByTestId("project")).toHaveTextContent("orbit");
    expect(storedProject()).toBe("orbit");
  });

  it("writes nothing back once signed out meanwhile", async () => {
    mockStored.set("session", JSON.stringify(session));
    await render(
      <SessionProvider>
        <Harness />
      </SessionProvider>,
    );
    await screen.findByText("acme");

    await fireEvent.press(screen.getByText("Kite"));
    await fireEvent.press(screen.getByText("Sign out"));
    await landWrites();

    expect(screen.getByTestId("project")).toHaveTextContent("signed out");
    expect(mockStored.has("session")).toBe(false);
  });
});

/** Something kept by "owner-0", checked to be there (the cache started before the load's generation is read). */
function keepFixture() {
  const owner = startCache("owner-0");
  keep("kept", { rows: [] }, cacheGeneration(), owner);
  expect(cached("kept", owner)).not.toBeNull();
}

describe("signing in", () => {
  it("starts with nothing kept, however the last session went (a restored phone, a lost keystore)", async () => {
    // Kept by an earlier session that never signed out here.
    keepFixture();
    await render(
      <SessionProvider>
        <Harness />
      </SessionProvider>,
    );
    expect(await screen.findByText("signed out")).toBeTruthy();

    await fireEvent.press(screen.getByText("Sign in"));
    await landWrites();
    expect(cached("kept", "owner-0")).toBeNull();
    // The new session owns the cache from now on: kept with its owner, it reads back.
    const owner = (JSON.parse(mockStored.get("session")!) as { owner?: string }).owner;
    expect(owner).toBeTruthy();
    keep("mine", { rows: [] }, cacheGeneration(), owner);
    expect(cached("mine", owner)).not.toBeNull();
  });
});

describe("signing out", () => {
  // Something kept to read offline, from this account.
  beforeEach(keepFixture);

  it("removes the phone's registration first, without waiting for it", async () => {
    mockStored.set("session", JSON.stringify(session));
    const asked: string[] = [];
    // The server never answers the removal.
    jest.mocked(globalThis.fetch).mockImplementation(async (url, init) => {
      asked.push(`${init?.method} ${String(url)}`);
      return String(url).includes("/devices/") ? new Promise<never>(() => {}) : new Response("{}");
    });
    await render(
      <SessionProvider>
        <Harness />
      </SessionProvider>,
    );
    await screen.findByText("acme");

    await fireEvent.press(screen.getByText("Sign out"));
    await landWrites();

    expect(screen.getByTestId("project")).toHaveTextContent("signed out");
    expect(mockStored.has("session")).toBe(false);
    const removal = asked.indexOf("DELETE https://tuti.example.com/api/v1/devices/phone-1");
    expect(removal).toBeGreaterThan(-1);
    expect(removal).toBeLessThan(asked.indexOf("POST https://tuti.example.com/api/auth/sign-out"));
    // The notifications shown go too, and what was kept to read offline.
    expect(mockDismissed).toHaveBeenCalled();
    expect(cached("kept", "owner-0")).toBeNull();
  });

  it("takes the notifications shown off when the server ends the session too", async () => {
    mockStored.set("session", JSON.stringify(session));
    mockDismissed.mockClear();
    jest.mocked(globalThis.fetch).mockImplementation(async (url) => (String(url).endsWith("/projects") ? new Response("{}", { status: 401 }) : new Response("{}")));
    await render(
      <SessionProvider>
        <Harness />
      </SessionProvider>,
    );
    await screen.findByText("acme");

    await fireEvent.press(screen.getByText("Call"));
    await landWrites();

    expect(await screen.findByText("signed out")).toBeTruthy();
    expect(mockDismissed).toHaveBeenCalled();
    expect(cached("kept", "owner-0")).toBeNull();
  });
});
