import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";

import { type Api, createApi } from "./api";
import { dueForRecheck, forgetSession, readSession, type Session, sessionHolds, writeSession } from "./session-store";
import type { SignedIn } from "./sign-in";

export type { Session };

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

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  const save = useCallback(
    async (next: Session | null) => {
      setSession(next);
      await writeSession(next);
    },
    [],
  );

  const signOut = useCallback(async () => {
    setSession(null);
    await forgetSession();
  }, []);

  // A session found ended (a check, a 401, which can answer late): signed out only if it's still the one in use, so a
  // teammate who signed out and back in meanwhile stays signed in.
  const ended = useCallback(async (which: Session) => {
    setSession((now) => (now?.token === which.token ? null : now));
    await forgetSession(which);
  }, []);

  // Reading the session keeps it going (API calls don't): at launch, and on coming back to the foreground twice a day, as
  // an app left open for days never launches again. One that ended elsewhere signs out here.
  const lastChecked = useRef(0);
  const check = useCallback(
    async (stored: Session) => {
      lastChecked.current = Date.now();
      if (!(await sessionHolds(stored))) {
        await ended(stored);
      }
    },
    [ended],
  );
  useEffect(() => {
    void readSession().then((restored) => {
      setSession(restored);
      if (restored) {
        void check(restored);
      }
    });
  }, [check]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && session && dueForRecheck(lastChecked.current, Date.now())) {
        void check(session);
      }
    });
    return () => subscription.remove();
  }, [session, check]);

  const value = useMemo<SessionContext>(
    () => ({
      session,
      signIn: (signedIn) => save(signedIn),
      signOut,
      setProject: (project) => save(session ? { ...session, project } : null),
      api: session ? createApi(session, () => void ended(session)) : null,
    }),
    [session, save, signOut, ended],
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
