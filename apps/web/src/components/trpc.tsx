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
        <ClientContext value={client}>
          <InOrderProvider>{children}</InOrderProvider>
        </ClientContext>
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

/** The page's one queue (TrpcProvider gives it), so saves from different components land in order too. */
const InOrderContext = createContext<InOrder | null>(null);

/** Gives `children` one queue for their saves (useInOrder). TrpcProvider has one; tests can use it alone. */
export function InOrderProvider({ children }: { children: React.ReactNode }) {
  const [inOrder] = useState(queue);
  return <InOrderContext value={inOrder}>{children}</InOrderContext>;
}

/**
 * Saves one at a time, in the order they're asked for, as server actions ran: tRPC mutations otherwise overlap, and a
 * later save could land before an earlier one and be overwritten by it. One queue for the page (InOrderProvider), so a
 * component's save and another's on the same page (a model typed for Checks, then the Checks switch) keep their order;
 * outside one, the component's own. A save waits for the one before it, which may have failed.
 */
export function useInOrder(): InOrder {
  const shared = useContext(InOrderContext);
  const [own] = useState(queue);
  return shared ?? own;
}
