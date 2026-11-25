import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";

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
  const { session, setProject, signOut } = useSession();
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
