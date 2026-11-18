"use client";

import {
  type ApiAuth,
  type ApiDoc,
  type ApiOperation,
  curlCommand,
  exampleRequest,
  paramText,
  readUpTo,
  shownUrl,
  tryAuth,
  tryInput,
  tryParams,
  tryRequest,
  tryServers,
} from "@tuti/shared/api-reference";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";

import { copyText } from "@/components/copy-button";
import { usePortalHref, usePortalSlug } from "@/components/portal-base";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import type { TryAnswer } from "@/server/api-try";

/**
 * Try it on an operation's page (docs/plan.md, API reference in Docs, A12; GraphQL's, A13): the console, a panel from
 * the right (a sheet from the bottom on phones), with the server, the key, the parameters and the body (GraphQL: the
 * query and its variables), prefilled from the examples. It sends from the browser first; an API that doesn't let browsers call it (a network error, which is what
 * CORS refusing looks like) gets the request through Tuti instead (server/api-try.ts). The key stays in this tab
 * (sessionStorage) and goes nowhere but in the request.
 */

/** The most of an answer shown, as through Tuti. */
const SHOWN_BYTES = 2_000_000;

/** How a request went: from the browser, or through Tuti and why. */
type Via = "browser" | "cors" | "cookies" | "redirect";

type Result =
  | { answer: TryAnswer; via: Via }
  | { error: string; via: Via }
  /** Sent from the browser, which may not read the answer: the API may have run it, so Tuti sends it again only when asked. */
  | { unread: "cors" | "redirect" };

/** The shared select, the width of its field. */
function Pick({ id, label, value, options, onChange }: { id?: string; label?: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
  return (
    <Select items={Object.fromEntries(options.map((o) => [o.value, o.label]))} value={value} onValueChange={(next) => onChange(String(next))}>
      <SelectTrigger id={id} aria-label={label} className="w-full min-w-0">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** What a scheme's key is called by the input that asks for it. */
const keyLabel = (auth: ApiAuth) =>
  auth.kind === "header" ? `API key (${auth.name} header)` : auth.kind === "query" ? `API key (${auth.name} query parameter)` : auth.kind === "cookie" ? `API key (${auth.name} cookie)` : auth.kind === "bearer" ? "Bearer token" : "Access token";

/** The keys typed for this reference, in this tab only. */
function useKeys(reference: string) {
  // The project's too: two projects' portals under paths of one site share its origin, and its session storage, and
  // their references can share a slug. One API's key must never be another's.
  const storage = `tuti.try-it.${usePortalSlug()}.${reference}`;
  const [keys, setKeys] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(storage) ?? "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(storage, JSON.stringify(keys));
    } catch {
      // Storage off: kept until the console closes.
    }
  }, [storage, keys]);
  return [keys, setKeys] as const;
}

/** The "Try it" button by the operation's method and path, and its console. */
export function TryIt(props: Props) {
  const [open, setOpen] = useState(false);
  const phone = useIsMobile();
  // Here, not in the console: what the reader typed and the last answer stay while it's closed (the key is kept apart).
  const form = useForm(props);
  return (
    <>
      <Button size="sm" className="ml-auto" onClick={() => setOpen(true)}>
        Try it
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side={phone ? "bottom" : "right"}
          className="w-full gap-0 p-0 data-[side=bottom]:max-h-[92dvh] data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
        >
          <Console {...props} form={form} />
        </SheetContent>
      </Sheet>
    </>
  );
}

type Props = { reference: string; operationSlug: string; doc: ApiDoc; operation: ApiOperation; base: string | null };

/** The console's fields, prefilled as the examples are, its last answer and the request on its way. */
function useForm({ doc, operation, base }: Props) {
  const servers = useMemo(() => tryServers(doc, operation, base), [doc, operation, base]);
  const [server, setServer] = useState(servers[0]!.url);
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [params, setParams] = useState<Record<string, string>>(() =>
    Object.fromEntries(tryParams(doc, operation).map((param) => [`${param.in}:${param.name}`, param.required || param.example !== undefined ? paramText(param) : ""])),
  );
  const [body, setBody] = useState(() => exampleRequest(doc, operation).body ?? "");
  const [graphql, setGraphql] = useState(() => operation.query && { query: operation.query.text, variables: JSON.stringify(operation.query.variables, null, 2) });
  const [result, setResult] = useState<Result | null>(null);
  const [sending, setSending] = useState(false);
  /** The latest send, and how to stop it: an answer to an earlier one is dropped. */
  const latestRef = useRef<{ id: number; stop?: AbortController }>({ id: 0 });
  // Leaving the operation (another one's page) stops what it was sending.
  useEffect(() => {
    const latest = latestRef;
    return () => latest.current.stop?.abort();
  }, []);
  return { servers, server, setServer, variables, setVariables, params, setParams, body, setBody, graphql, setGraphql, result, setResult, sending, setSending, latestRef };
}

/** How long a request from the browser may take, as through Tuti; */
const TIMEOUT_MS = 15_000;
/** and one through Tuti, which gives the API 15 seconds itself: a little more, for the way there and back. */
const TUTI_TIMEOUT_MS = 20_000;

function Console({ reference, operationSlug, doc, operation, base, form }: Props & { form: ReturnType<typeof useForm> }) {
  const href = usePortalHref();
  const { servers, server, setServer, variables, setVariables, params, setParams, body, setBody, graphql, setGraphql, result, setResult, sending, setSending, latestRef } = form;
  const { schemes, optional } = tryAuth(doc, operation);
  const shown = tryParams(doc, operation);
  const [keys, setKeys] = useKeys(reference);
  const sendButton = useRef<HTMLButtonElement>(null);
  const chosen = servers.find((s) => s.url === server)!;
  const answer = useRef<HTMLDivElement>(null);
  // Once per answer, not on every keystroke in the query: a body can be 2 MB.
  const isGraphql = !!graphql;
  const errors = useMemo(() => (isGraphql && result && "answer" in result ? graphqlErrors(result.answer) : []), [isGraphql, result]);
  // Below the fields, often out of sight (a phone's sheet): brought into view, focus left on Send.
  useEffect(() => {
    if (result) answer.current?.scrollIntoView({ block: "nearest" });
  }, [result]);

  const input = tryInput(doc, operation, { server, variables, params, keys, body, graphql });
  const made = tryRequest(doc, operation, base, input);

  /** `through`: sent through Tuti at the reader's word, after the browser couldn't show the answer (and why). */
  async function send(through?: "cors" | "redirect") {
    if ("error" in made) {
      setResult({ error: made.error, via: "browser" });
      return;
    }
    // A send replaces any still on its way (with the console closed and opened again, say): that one is stopped, and
    // whatever it answers is dropped.
    latestRef.current.stop?.abort();
    const stop = new AbortController();
    const id = (latestRef.current = { id: latestRef.current.id + 1, stop }).id;
    const settle = (next: Result) => {
      if (latestRef.current.id === id) setResult(next);
    };
    setSending(true);
    // "Send through Tuti" goes with the answer it's in: focus moves to Send, which stays.
    if (through) sendButton.current?.focus();
    // Emptied, so the answer's arrival is read out even when it's the same as the last.
    setResult(null);
    const timers: ReturnType<typeof setTimeout>[] = [];
    /** A clock of its own for one request: stopped by a newer send, or after `ms`. */
    const limited = (ms: number) => {
      const own = new AbortController();
      stop.signal.addEventListener("abort", () => own.abort(stop.signal.reason));
      timers.push(setTimeout(() => own.abort(new DOMException("Timed out", "TimeoutError")), ms));
      return { signal: own.signal, timedOut: () => own.signal.reason instanceof DOMException && own.signal.reason.name === "TimeoutError" };
    };

    async function throughTuti(via: Exclude<Via, "browser">) {
      // Its own clock, from when it starts: Tuti gives the API its 15 seconds, and says so itself when they run out.
      const { signal, timedOut } = limited(TUTI_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(href(`/docs/${reference}/${operationSlug}/try`), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
          signal,
        });
      } catch {
        settle({ error: timedOut() ? "The API didn't answer within 15 seconds" : "Couldn't reach Tuti to send it. Check your connection and try again.", via });
        return;
      }
      let json: TryAnswer | { error: string };
      try {
        json = (await response.json()) as TryAnswer | { error: string };
      } catch {
        // Not Tuti's answer: a page from something in between (a proxy's 502 or 413, say).
        settle({ error: `Tuti couldn't send it: it answered ${[response.status, response.statusText].filter(Boolean).join(" ")}.`, via });
        return;
      }
      settle("error" in json ? { error: json.error, via } : { answer: json, via });
    }

    try {
      // A browser doesn't send cookies it's given to another site: those go through Tuti.
      if (through || input.cookies.length > 0) {
        await throughTuti(through ?? "cookies");
        return;
      }
      const started = performance.now();
      const { signal, timedOut } = limited(TIMEOUT_MS);
      let response: Response;
      try {
        // Nothing of the reader's own: no cookies of a site the API shares with the portal, no referrer.
        response = await fetch(made.url, {
          method: made.method,
          headers: made.headers,
          body: made.body,
          credentials: "omit",
          referrerPolicy: "no-referrer",
          // Not followed, as through Tuti: a browser keeps a key header (X-API-Key) on a redirect to another site.
          redirect: "manual",
          signal,
        });
      } catch (error) {
        if (signal.aborted) {
          settle({ error: "The API didn't answer within 15 seconds", via: "browser" });
          return;
        }
        // Refused by CORS, or no network: both a TypeError, and the API may have run it all the same (a browser only
        // asks first about some requests, and an API may allow the asking and not the answer). A GET or HEAD only
        // reads, so Tuti sends it; anything else only when the reader asks.
        if (!(error instanceof TypeError)) throw error;
        if (made.method === "GET" || made.method === "HEAD") await throughTuti("cors");
        else settle({ unread: "cors" });
        return;
      }
      // A redirect, not followed, can't be read in a browser (no status, no Location): said so, and Tuti can show it.
      if (response.type === "opaqueredirect") {
        settle({ unread: "redirect" });
        return;
      }
      let read;
      try {
        // As it arrives, up to the limit: a huge or endless answer can't fill the tab.
        read = await readUpTo(response.body, SHOWN_BYTES);
      } catch {
        settle({
          error: timedOut() ? `The API answered ${response.status}, and the rest didn't arrive within 15 seconds.` : `The API answered ${response.status}, and the connection dropped before the rest arrived.`,
          via: "browser",
        });
        return;
      }
      settle({
        via: "browser",
        answer: {
          status: response.status,
          statusText: response.statusText,
          headers: [...response.headers],
          body: read.text,
          size: read.size,
          cut: read.cut,
          ms: Math.round(performance.now() - started),
        },
      });
    } finally {
      for (const timer of timers) clearTimeout(timer);
      if (latestRef.current.id === id) setSending(false);
    }
  }

  // Says so either way, as the app's other copy buttons do: a clipboard can be off (a portal over plain http, a permission denied).
  const copy = () => "url" in made && copyText(curlCommand({ method: made.method, url: made.url.href, headers: Object.fromEntries(made.headers), body: made.body }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-1 border-b border-divider px-4 pt-4 pb-3 pr-12">
        <SheetTitle className="text-base">Try it</SheetTitle>
        <SheetDescription className="sr-only">Send a request to {operation.title}, with your own key.</SheetDescription>
        <p className="flex min-w-0 items-baseline gap-2 font-mono text-xs">
          <span className="shrink-0 font-semibold">{operation.kind}</span>
          <span className="min-w-0 break-all text-muted-foreground">{"url" in made ? shownUrl(doc, operation, made) : operation.path}</span>
        </p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
        {(servers.length > 1 || chosen.variables) && (
          <Group title="Server">
            {servers.length > 1 && (
              // The group's heading names it.
              <Pick label="Server" value={server} options={servers.map((s) => ({ value: s.url, label: s.description ? `${s.description} (${s.url})` : s.url }))} onChange={setServer} />
            )}
            {Object.entries(chosen.variables ?? {}).map(([name, variable]) => (
              <Labelled key={name} label={name} mono>
                {(id) =>
                  variable.enum?.length ? (
                    <Pick
                      id={id}
                      value={variables[name] ?? variable.default}
                      options={variable.enum.map((value) => ({ value, label: value }))}
                      onChange={(value) => setVariables({ ...variables, [name]: value })}
                    />
                  ) : (
                    <Input id={id} value={variables[name] ?? variable.default} onChange={(event) => setVariables({ ...variables, [name]: event.target.value })} />
                  )
                }
              </Labelled>
            ))}
          </Group>
        )}
        {schemes.length > 0 && (
          <Group title="Authorization" note={`Kept in this tab only.${optional ? " Optional for this request." : ""}`}>
            {schemes.map((scheme) =>
              scheme.kind === "basic" ? (
                <div key={scheme.key} className="grid gap-3 sm:grid-cols-2">
                  {(["user", "password"] as const).map((part) => (
                    <Labelled key={part} label={part === "user" ? "Username" : "Password"}>
                      {(id) => (
                        <Input
                          id={id}
                          type={part === "password" ? "password" : "text"}
                          autoComplete="off"
                          value={keys[`${scheme.key}:${part}`] ?? ""}
                          onChange={(event) => setKeys({ ...keys, [`${scheme.key}:${part}`]: event.target.value })}
                        />
                      )}
                    </Labelled>
                  ))}
                </div>
              ) : (
                <Labelled key={scheme.key} label={keyLabel(scheme)}>
                  {(id) => (
                    <Input
                      id={id}
                      type="password"
                      autoComplete="off"
                      className="font-mono"
                      value={keys[scheme.key] ?? ""}
                      onChange={(event) => setKeys({ ...keys, [scheme.key]: event.target.value })}
                    />
                  )}
                </Labelled>
              ),
            )}
          </Group>
        )}
        {shown.length > 0 && (
          <Group title="Parameters">
            {shown.map((param) => {
              const at = `${param.in}:${param.name}`;
              return (
                <Labelled key={at} label={param.name} mono hint={[param.in === "header" ? "header" : param.in === "path" ? "path" : "query", param.required && "required"].filter(Boolean).join(" · ")}>
                  {(id) => <Input id={id} value={params[at] ?? ""} onChange={(event) => setParams({ ...params, [at]: event.target.value })} />}
                </Labelled>
              );
            })}
          </Group>
        )}
        {operation.body && operation.kind !== "GET" && operation.kind !== "HEAD" && (
          <Group title="Body" note={operation.body.contentType}>
            <Textarea aria-label="Body" spellCheck={false} rows={10} className="font-mono text-base md:text-xs" value={body} onChange={(event) => setBody(event.target.value)} />
          </Group>
        )}
        {graphql && (
          <>
            <Group title="Query">
              <Textarea aria-label="Query" spellCheck={false} rows={10} className="font-mono text-base md:text-xs" value={graphql.query} onChange={(event) => setGraphql({ ...graphql, query: event.target.value })} />
            </Group>
            <Group title="Variables" note="JSON">
              <Textarea aria-label="Variables" spellCheck={false} rows={4} className="font-mono text-base md:text-xs" value={graphql.variables} onChange={(event) => setGraphql({ ...graphql, variables: event.target.value })} />
            </Group>
          </>
        )}
        {/* Always there, so a screen reader reads the answer's one line as it arrives (not its body). */}
        <p aria-live="polite" className="sr-only">
          {result && summary(result, errors.length)}
        </p>
        {result && (
          <div ref={answer}>
            <Answer result={result} onThrough={(why) => void send(why)} sending={sending} errors={errors} />
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-divider px-4 py-3">
        <Button variant="outline" disabled={"error" in made} onClick={() => void copy()}>
          Copy as cURL
        </Button>
        <Button ref={sendButton} disabled={sending} focusableWhenDisabled onClick={() => void send()}>
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}

function Group({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {note && <p className="text-[0.8125rem] text-muted-foreground">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function Labelled({ label, hint, mono, children }: { label: string; hint?: string; mono?: boolean; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="flex flex-wrap items-baseline gap-x-2 text-[0.8125rem]">
        <span className={cn("font-medium break-all", mono && "font-mono")}>{label}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </label>
      {children(id)}
    </div>
  );
}

/** A size in words: 312 B, 4.2 KB, 1.8 MB. */
const size = (bytes: number) => (bytes < 1000 ? `${bytes} B` : bytes < 1_000_000 ? `${(bytes / 1000).toFixed(1)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`);

/** The body as it came, or pretty when it's JSON. */
function pretty(answer: TryAnswer) {
  try {
    return JSON.stringify(JSON.parse(answer.body), null, 2);
  } catch {
    return answer.body;
  }
}

/** A GraphQL answer's `errors`, each's message: what went wrong, though its status is often 200. */
function graphqlErrors(answer: TryAnswer): string[] {
  try {
    const { errors } = JSON.parse(answer.body) as { errors?: unknown };
    return Array.isArray(errors) ? errors.map((error) => String((error as { message?: unknown } | null)?.message ?? JSON.stringify(error))) : [];
  } catch {
    return [];
  }
}

/** Why the request went through Tuti, when it did. */
const throughLine = (result: Exclude<Result, { unread: "cors" | "redirect" }>) =>
  // Only for what was sent: an error from Tuti (it refused, or couldn't be reached) sent nothing.
  "error" in result
    ? null
    : result.via === "cors"
    ? "Sent through Tuti, since the API doesn't allow browser requests."
    : result.via === "cookies"
      ? "Sent through Tuti, since browsers don't send cookies to another site."
      : result.via === "redirect"
        ? "Sent through Tuti, which shows a redirect without following it."
        : null;

const UNREAD = {
  cors: "The API doesn't allow browser requests, so its answer can't be shown here. It may have run the request: send it through Tuti to see the answer, and it runs again.",
  redirect: "The API answered with a redirect, which Try it doesn't follow. Send it through Tuti to see its status and where it points; the request runs again.",
};

/** The answer in a line, for screen readers (with GraphQL's errors counted). */
function summary(result: Result, errors: number) {
  if ("unread" in result) return UNREAD[result.unread];
  const what =
    "error" in result
      ? result.error
      : `${result.answer.status} ${result.answer.statusText}, ${result.answer.ms} ms, ${size(result.answer.size)}${errors ? `, ${errors === 1 ? "1 error" : `${errors} errors`}` : ""}`;
  return [what, throughLine(result)].filter(Boolean).join(". ");
}

/** The answer: its status, time and size, its headers (closed), and its body. Or why it wasn't sent. */
/** `errors`: a GraphQL answer's error messages. */
function Answer({ result, onThrough, sending, errors }: { result: Result; onThrough: (why: "cors" | "redirect") => void; sending: boolean; errors: string[] }) {
  if ("unread" in result) {
    return (
      <section aria-label="Response" className="flex flex-col gap-2 border-t border-divider pt-4">
        <h3 className="text-sm font-semibold">Response</h3>
        <p className="text-sm">
          {UNREAD[result.unread]}
        </p>
        <Button variant="outline" className="self-start" disabled={sending} focusableWhenDisabled onClick={() => onThrough(result.unread)}>
          Send through Tuti
        </Button>
      </section>
    );
  }
  const through = throughLine(result);
  return (
    <section aria-label="Response" className="flex flex-col gap-2 border-t border-divider pt-4">
      <h3 className="text-sm font-semibold">Response</h3>
      {"error" in result ? (
        <p className="text-sm text-destructive">
          {result.error}
        </p>
      ) : (
        <>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs">
            <span className="flex items-center gap-1.5 font-semibold">
              <span
                aria-hidden
                className={cn(
                  "size-2 rounded-full",
                  result.answer.status < 300 ? "bg-status-completed" : result.answer.status < 500 ? "bg-status-in-progress" : "bg-destructive",
                )}
              />
              {result.answer.status} {result.answer.statusText}
            </span>
            <span className="text-muted-foreground">{result.answer.ms} ms</span>
            <span className="text-muted-foreground">{size(result.answer.size)}</span>
          </p>
          {result.answer.cut && <p className="text-[0.8125rem] text-muted-foreground">Showing the first 2 MB.</p>}
          {errors.length > 0 && (
            <div role="group" aria-label="Errors" className="flex flex-col gap-1 rounded-lg border border-destructive/40 p-3 text-sm">
              <p className="font-medium text-destructive">{errors.length === 1 ? "1 error" : `${errors.length} errors`}</p>
              <ul className="flex list-disc flex-col gap-1 pl-5 break-words">
                {/* ponytail: the first 20; the body below has them all. */}
                {errors.slice(0, 20).map((message, i) => (
                  <li key={i}>{message}</li>
                ))}
              </ul>
            </div>
          )}
          {result.answer.headers.length > 0 && (
            <details className="group/headers">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-sm font-medium [&::-webkit-details-marker]:hidden">
                <ChevronRightIcon aria-hidden className="size-3.5 transition-transform group-open/headers:rotate-90" />
                Headers ({result.answer.headers.length})
              </summary>
              <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-xs">
                {result.answer.headers.map(([name, value], i) => (
                  <div key={i} className="contents">
                    <dt className="text-muted-foreground">{name}</dt>
                    <dd className="break-all">{value}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
          {result.answer.body && (
            // Focusable, so a keyboard can scroll it (Safari doesn't reach one with nothing focusable inside).
            <pre
              tabIndex={0}
              aria-label="Response body"
              className="max-h-96 overflow-auto rounded-lg bg-secondary p-3 font-mono text-xs whitespace-pre-wrap break-all outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {pretty(result.answer)}
            </pre>
          )}
        </>
      )}
      {through && <p className="text-[0.8125rem] text-muted-foreground">{through}</p>}
    </section>
  );
}
