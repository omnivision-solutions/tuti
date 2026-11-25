import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";

import { type Api, createApi } from "./api";
import { latestOnly } from "./inbox";
import { afterChanged, afterEnded, forgetSession, inOrder, keepSession, readSession, recheckOnForeground, type Session, sessionHolds, writeSession } from "./session-store";
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

  // Storage is written one change at a time, in order: a project chosen just before signing out can't write the session
  // back after it's deleted.
  const [inTurn] = useState(inOrder);

  const save = useCallback((next: Session | null) => inTurn(() => keepSession(next, setSession, writeSession)), [inTurn]);

  const signOut = useCallback(async () => {
    setSession(null);
    await inTurn(() => forgetSession());
  }, [inTurn]);

  // The project chosen last wins: a choice still waiting its turn when a newer one comes is dropped, and one is saved
  // only into the session still stored (signed out, or into another account, meanwhile: nothing is written).
  const [choices] = useState(latestOnly);
  const choose = useCallback(
    (from: Session, project: string) => {
      const mine = choices.start();
      return inTurn(async () => {
        const stored = await readSession();
        if (!choices.isLatest(mine) || stored?.token !== from.token) {
          return;
        }
        await keepSession({ ...stored, project }, (next) => setSession((now) => afterChanged(now, next)), writeSession);
      });
    },
    [inTurn, choices],
  );

  // A session found ended (a check, a 401, which can answer late): signed out only if it's still the one in use, so a
  // teammate who signed out and back in meanwhile stays signed in.
  const ended = useCallback(async (which: Session) => {
    setSession((now) => afterEnded(now, which));
    await inTurn(() => forgetSession(which));
  }, [inTurn]);

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
      if (recheckOnForeground(state, !!session, lastChecked.current, Date.now()) && session) {
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
      // Shown once saved, and only if it's still the session in use (signed out meanwhile stays signed out).
      setProject: (project) => (session ? choose(session, project) : Promise.resolve()),
      api: session ? createApi(session, () => void ended(session)) : null,
    }),
    [session, save, signOut, ended, choose],
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
