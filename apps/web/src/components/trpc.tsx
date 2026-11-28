"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, httpLink, splitLink, type TRPCClient, TRPCClientError } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import { createContext, useContext, useState } from "react";
import superjson from "superjson";

import { PAGE_LANGUAGE_HEADER, splitLanguage } from "@/lib/language-addresses";
import { withBase } from "@/lib/portal-base";
import type { AppRouter } from "@/server/trpc/router";

const { TRPCProvider: Provider, useTRPC } = createTRPCContext<AppRouter>();

/** The procedures for React Query (`useQuery(trpc.aiFirst.get.queryOptions(…))`). */
export { useTRPC };

const ClientContext = createContext<TRPCClient<AppRouter> | null>(null);

/** Outside a provider: a client that fails only when it's called, so rendering never does (a page rendered on its own). */
const missing = new Proxy({} as TRPCClient<AppRouter>, {
  get: () => {
    throw new Error("The tRPC client is called outside a <TrpcProvider>");
  },
});

/** The plain client, for saves and uploads. Reading it never throws; calling it outside a provider does. */
export function useTRPCClient(): TRPCClient<AppRouter> {
  return useContext(ClientContext) ?? missing;
}

/** A failed call's message, as the server said it (an OperationError's), for the form's error line; else (offline, a proxy's page) `otherwise`. */
export const errorMessage = (error: unknown, otherwise = "Something went wrong. Try again.") => (error instanceof TRPCClientError && error.shape ? error.message : otherwise);

/**
 * A call as the widget's person (server/trpc/context.ts): someone the customer's site signed in (their widget token), or
 * a signed-out visitor (their visitor token). Without either, the call is the page's cookie session, as any other.
 * Pass as the call's options: `client.votes.set.mutate(input, widgetCall(token))`.
 */
export const widgetCall = (token: string | null | undefined, visitor?: string | null) => ({
  context: { authorization: token ? `Widget ${token}` : visitor ? `Visitor ${visitor}` : undefined },
});

/**
 * What the browser fetches or saves goes through /api/trpc (pages read on the server, server/trpc/server.ts). `base`:
 * where a portal is on its team's site (acme.com/portal), which forwards only its own path. A call with its own
 * `Authorization` (widgetCall) goes on its own, never batched with another's.
 */
export function TrpcProvider({ base = "", children }: { base?: string; children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } }));
  const [client] = useState(() => {
    const url = withBase(base, "/api/trpc");
    // The page's language, on a language's address only (/de/…, after the portal's base): every call says it
    // (PAGE_LANGUAGE_HEADER), since its own address isn't the page's; a save there keeps it as the reader's
    // (rememberPageLanguage). Read from the address as each call goes, so it's the page's now.
    const said = (): Record<string, string> => {
      const path = window.location.pathname;
      const language = path.startsWith(base) ? splitLanguage(path.slice(base.length) || "/")?.code : undefined;
      return language ? { [PAGE_LANGUAGE_HEADER]: language } : {};
    };
    return createTRPCClient<AppRouter>({
      links: [
        splitLink({
          condition: (op) => typeof op.context.authorization === "string",
          true: httpLink({ url, transformer: superjson, headers: ({ op }) => ({ ...said(), authorization: op.context.authorization as string }) }),
          false: httpBatchLink({ url, transformer: superjson, headers: said }),
        }),
      ],
    });
  });
  return (
    <QueryClientProvider client={queryClient}>
      <Provider trpcClient={client} queryClient={queryClient}>
        <ClientContext value={client}>{children}</ClientContext>
      </Provider>
    </QueryClientProvider>
  );
}

type InOrder = <T>(save: () => Promise<T>) => Promise<T>;

/** Runs saves one at a time, in the order asked for, each after the one before it, failed or not. */
function queue(): InOrder {
  let last: Promise<unknown> = Promise.resolve();
  return <T,>(save: () => Promise<T>): Promise<T> => {
    const run = last.then(save, save);
    last = run.catch(() => {});
    return run;
  };
}

/** The page's one queue (a settings page's SettingsPane gives it), so saves from different components land in order too. */
const InOrderContext = createContext<InOrder | null>(null);

/**
 * Gives `children` one queue for their saves (useInOrder), for as long as they're mounted: a page's, never the app's, so a
 * save that never settles holds back that page's later saves only, and the next page starts with a fresh queue.
 */
export function InOrderProvider({ children }: { children: React.ReactNode }) {
  const [inOrder] = useState(queue);
  return <InOrderContext value={inOrder}>{children}</InOrderContext>;
}

/**
 * Saves one at a time, in the order they're asked for, as server actions ran: tRPC mutations otherwise overlap, and a
 * later save could land before an earlier one and be overwritten by it. One queue for the page (InOrderProvider, in SettingsPane), so a
 * component's save and another's on the same page (a model typed for Checks, then the Checks switch) keep their order;
 * outside one, the component's own. A save waits for the one before it, which may have failed.
 */
export function useInOrder(): InOrder {
  const shared = useContext(InOrderContext);
  const [own] = useState(queue);
  return shared ?? own;
}
