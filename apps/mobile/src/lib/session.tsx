import * as SecureStore from "expo-secure-store";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { type Api, authRequest, createApi } from "./api";
import { type SignedIn, STORE_OPTIONS } from "./sign-in";

/** The signed-in teammate's session: the server, its token for /api/v1, its cookie for /api/auth, and the project they chose. */
export type Session = SignedIn & { project?: string };

type SessionContext = {
  /** undefined while it's read from storage. */
  session: Session | null | undefined;
  signIn: (signedIn: SignedIn) => Promise<void>;
  signOut: () => Promise<void>;
  setProject: (slug: string) => Promise<void>;
  /** The API as the teammate, in their project: null when signed out. */
  api: Api | null;
};

const Context = createContext<SessionContext | null>(null);
const KEY = "session";

/** The stored session; none if there's none, or it can't be read (signed out, rather than stuck on the splash screen). */
const readSession = () =>
  SecureStore.getItemAsync(KEY, STORE_OPTIONS)
    .then((stored) => (stored ? (JSON.parse(stored) as Session) : null))
    .catch(() => null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  const save = useCallback(async (next: Session | null) => {
    setSession(next);
    await (next ? SecureStore.setItemAsync(KEY, JSON.stringify(next), STORE_OPTIONS) : SecureStore.deleteItemAsync(KEY, STORE_OPTIONS));
  }, []);

  const signOut = useCallback(async () => {
    const stored = await readSession();
    await save(null);
    if (stored) {
      // Ends the session on the server too; signed out here either way.
      await authRequest(stored.server, "/sign-out", { body: {}, cookie: stored.cookie }).catch(() => {});
    }
  }, [save]);

  useEffect(() => {
    void readSession().then((restored) => {
      setSession(restored);
      // Reading the session keeps it going (API calls don't); one that ended elsewhere signs out here.
      if (restored) {
        void authRequest<unknown>(restored.server, "/get-session", { cookie: restored.cookie }).then(
          (current) => {
            if (current === null) {
              void signOut();
            }
          },
          () => {},
        );
      }
    });
  }, [signOut]);

  const value = useMemo<SessionContext>(
    () => ({
      session,
      signIn: (signedIn) => save(signedIn),
      signOut,
      setProject: (project) => save(session ? { ...session, project } : null),
      api: session ? createApi(session, () => void signOut()) : null,
    }),
    [session, save, signOut],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSession() {
  const context = useContext(Context);
  if (!context) {
    throw new Error("useSession is used outside SessionProvider");
  }
  return context;
}

/** For signed-in screens: the API as the teammate. */
export function useApi(): Api {
  const { api } = useSession();
  if (!api) {
    throw new Error("useApi is used on a signed-out screen");
  }
  return api;
}
