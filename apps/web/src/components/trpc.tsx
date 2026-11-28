"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, type TRPCClient, TRPCClientError } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import { createContext, useContext, useState } from "react";
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
