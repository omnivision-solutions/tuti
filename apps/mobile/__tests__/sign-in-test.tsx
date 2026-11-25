import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";

import SignIn from "@/app/sign-in";
import type { SignedIn } from "@/lib/sign-in";

jest.mock("react-native-safe-area-context", () => require("react-native-safe-area-context/jest/mock").default);
// Opened by Google's way back: `tuti://sign-in?state=…&code=…`.
jest.mock("expo-router", () => ({ useLocalSearchParams: () => ({ state: "state-1", code: "code-1" }) }));

const mockSignIn = jest.fn<(signedIn: SignedIn) => Promise<void>>(() => Promise.resolve());
jest.mock("@/lib/session", () => ({ useSession: () => ({ signIn: mockSignIn }) }));

// The way back's exchange waits until the test answers it.
let mockFinish!: (signedIn: SignedIn) => void;
const mockContinueWith = jest.fn();
const mockSignInWithPassword = jest.fn();
jest.mock("@/lib/sign-in", () => ({
  ...jest.requireActual<object>("@/lib/sign-in"),
  finishSignIn: () => new Promise((resolve) => (mockFinish = resolve)),
  continueWith: (...args: unknown[]) => mockContinueWith(...args),
  signInWithPassword: (...args: unknown[]) => mockSignInWithPassword(...args),
}));

const signedIn = { server: "https://tuti.so", token: "token-1", cookie: "c" };

afterEach(() => {
  jest.clearAllMocks();
});

describe("the sign-in screen opened by a way back", () => {
  it("starts no other sign-in while the way back's exchange is pending", async () => {
    await render(<SignIn />);

    await fireEvent.press(screen.getByRole("button", { name: "Continue with Google" }));
    await fireEvent.press(screen.getByRole("button", { name: "Continue with GitHub" }));
    await fireEvent.changeText(screen.getByLabelText("Email"), "e2e-olive@example.com");
    await fireEvent.changeText(screen.getByLabelText("Password"), "correct horse battery staple");
    await fireEvent.press(screen.getByRole("button", { name: "Sign in" }));

    expect(mockContinueWith).not.toHaveBeenCalled();
    expect(mockSignInWithPassword).not.toHaveBeenCalled();

    // Once it's in, the session is the way back's.
    await act(async () => mockFinish(signedIn));
    expect(mockSignIn).toHaveBeenCalledWith(signedIn);
  });

  it("signs nothing in when the exchange finishes after the screen is gone", async () => {
    const { unmount } = await render(<SignIn />);
    await unmount();
    await act(async () => mockFinish(signedIn));
    expect(mockSignIn).not.toHaveBeenCalled();
  });
});
