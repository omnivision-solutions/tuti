"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import { useState } from "react";
import superjson from "superjson";

import { withBase } from "@/lib/portal-base";
import type { AppRouter } from "@/server/trpc/router";

const { TRPCProvider: Provider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

/** The procedures for React Query (`useQuery(trpc.aiFirst.get.queryOptions(…))`), and the plain client for saves. */
export { useTRPC, useTRPCClient };

/** A failed call's message, as the server said it (an OperationError's), for the form's error line; else (offline, a proxy's page) a plain one. */
export const errorMessage = (error: unknown) => (error instanceof TRPCClientError && error.shape ? error.message : "Something went wrong. Try again.");

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
        {children}
      </Provider>
    </QueryClientProvider>
  );
}
