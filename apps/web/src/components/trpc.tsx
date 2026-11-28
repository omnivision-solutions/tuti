"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, type TRPCClient, TRPCClientError } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import { createContext, useCallback, useContext, useRef, useState } from "react";
import superjson from "superjson";

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
 * What the browser fetches or saves goes through /api/trpc (pages read on the server, server/trpc/server.ts). `base`:
 * where a portal is on its team's site (acme.com/portal), which forwards only its own path.
 */
export function TrpcProvider({ base = "", children }: { base?: string; children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } }));
  const [client] = useState(() => createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: withBase(base, "/api/trpc"), transformer: superjson })] }));
  return (
    <QueryClientProvider client={queryClient}>
      <Provider trpcClient={client} queryClient={queryClient}>
        <ClientContext value={client}>{children}</ClientContext>
      </Provider>
    </QueryClientProvider>
  );
}

/**
 * A component's saves one at a time, in the order they're asked for, as its server actions ran: tRPC mutations
 * otherwise overlap, and a later save could land before an earlier one and be overwritten by it. A save waits for the
 * one before it, which may have failed.
 */
export function useInOrder() {
  const last = useRef<Promise<unknown>>(Promise.resolve());
  return useCallback(<T,>(save: () => Promise<T>): Promise<T> => {
    const run = last.current.then(save, save);
    last.current = run.catch(() => {});
    return run;
  }, []);
}
