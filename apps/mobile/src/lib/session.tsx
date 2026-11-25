import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { type Api, createApi } from "./api";
import { forgetSession, readSession, type Session, sessionHolds, writeSession } from "./session-store";
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

  const save = useCallback(async (next: Session | null) => {
    setSession(next);
    await writeSession(next);
  }, []);

  const signOut = useCallback(async () => {
    setSession(null);
    await forgetSession();
  }, []);

  useEffect(() => {
    void readSession().then(async (restored) => {
      setSession(restored);
      // One that ended elsewhere signs out here.
      if (restored && !(await sessionHolds(restored))) {
        await signOut();
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
