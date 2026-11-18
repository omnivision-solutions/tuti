"use client";

import {
  type ApiAuth,
  type ApiDoc,
  type ApiOperation,
  curlCommand,
  exampleRequest,
  paramText,
  tryAuth,
  type TryInput,
  tryRequest,
  tryServers,
} from "@tuti/shared/api-reference";
import { ChevronRightIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";

import { usePortalHref } from "@/components/portal-base";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import type { TryAnswer } from "@/server/api-try";

/**
 * Try it on an OpenAPI operation's page (docs/plan.md, API reference in Docs, A12): the console, a panel from the right
 * (a sheet from the bottom on phones), with the server, the key, the parameters and the body, prefilled from the
 * examples. It sends from the browser first; an API that doesn't let browsers call it (a network error, which is what
 * CORS refusing looks like) gets the request through Tuti instead (server/api-try.ts). The key stays in this tab
 * (sessionStorage) and goes nowhere but in the request.
 */

/** The most of an answer shown, as through Tuti. */
const SHOWN_BYTES = 2_000_000;

type Result =
  | { answer: TryAnswer; via: "browser" | "cors" | "cookies" }
  | { error: string; via: "browser" | "cors" | "cookies" };

const field = "h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

/** What a scheme's key is called by the input that asks for it. */
const keyLabel = (auth: ApiAuth) =>
  auth.kind === "header" ? `API key (${auth.name} header)` : auth.kind === "query" ? `API key (${auth.name} query parameter)` : auth.kind === "cookie" ? `API key (${auth.name} cookie)` : auth.kind === "bearer" ? "Bearer token" : "Access token";

/** Base64 of text as UTF-8, as Basic authentication sends a username and password. */
const base64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

/** The keys typed for this reference, in this tab only. */
function useKeys(reference: string) {
  const storage = `tuti.try-it.${reference}`;
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
export function TryIt(props: { reference: string; operationSlug: string; doc: ApiDoc; operation: ApiOperation; base: string | null }) {
  const [open, setOpen] = useState(false);
  const phone = useIsMobile();
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
          <Console {...props} />
        </SheetContent>
      </Sheet>
    </>
  );
}

function Console({ reference, operationSlug, doc, operation, base }: { reference: string; operationSlug: string; doc: ApiDoc; operation: ApiOperation; base: string | null }) {
  const href = usePortalHref();
  const servers = useMemo(() => tryServers(doc, operation, base), [doc, operation, base]);
  const { schemes, optional } = tryAuth(doc, operation);
  const shown = operation.params.filter((param) => param.in === "path" || param.in === "query" || param.in === "header");
  const [server, setServer] = useState(servers[0]!.url);
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [params, setParams] = useState<Record<string, string>>(() =>
    Object.fromEntries(shown.map((param) => [`${param.in}:${param.name}`, param.required || param.example !== undefined ? paramText(param) : ""])),
  );
  const [body, setBody] = useState(() => exampleRequest(doc, operation).body ?? "");
  const [keys, setKeys] = useKeys(reference);
  const [result, setResult] = useState<Result | null>(null);
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const chosen = servers.find((s) => s.url === server)!;

  const input: TryInput = { server, variables, path: {}, query: [], headers: [], cookies: [], body: operation.body ? body : null };
  for (const param of shown) {
    const value = params[`${param.in}:${param.name}`] ?? "";
    if (param.in === "path") input.path[param.name] = value;
    else if (value !== "") (param.in === "query" ? input.query : input.headers).push([param.name, value]);
  }
  for (const scheme of schemes) {
    const value = keys[scheme.key] ?? "";
    if (scheme.kind === "basic") {
      const [user = "", password = ""] = [keys[`${scheme.key}:user`], keys[`${scheme.key}:password`]];
      if (user || password) input.headers.push(["Authorization", `Basic ${base64(`${user}:${password}`)}`]);
    } else if (value === "") continue;
    else if (scheme.kind === "header") input.headers.push([scheme.name, value]);
    else if (scheme.kind === "query") input.query.push([scheme.name, value]);
    else if (scheme.kind === "cookie") input.cookies.push([scheme.name, value]);
    else input.headers.push(["Authorization", `Bearer ${value}`]);
  }
  if (operation.body && input.body !== null && input.body !== "") input.headers.push(["Content-Type", operation.body.contentType]);
  const made = tryRequest(doc, operation, base, input);

  async function throughTuti(via: "cors" | "cookies") {
    try {
      const response = await fetch(href(`/docs/${reference}/${operationSlug}/try`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const json = (await response.json()) as TryAnswer | { error: string };
      setResult("error" in json ? { error: json.error, via } : { answer: json, via });
    } catch {
      setResult({ error: "Couldn't reach Tuti to send it. Check your connection and try again.", via });
    }
  }

  async function send() {
    if ("error" in made) {
      setResult({ error: made.error, via: "browser" });
      return;
    }
    setSending(true);
    setResult(null);
    try {
      // A browser doesn't send cookies it's given to another site: those go through Tuti.
      if (input.cookies.length > 0) {
        await throughTuti("cookies");
        return;
      }
      const started = performance.now();
      try {
        const response = await fetch(made.url, { method: made.method, headers: made.headers, body: made.body });
        const text = await response.text();
        const bytes = new TextEncoder().encode(text).length;
        setResult({
          via: "browser",
          answer: {
            status: response.status,
            statusText: response.statusText,
            headers: [...response.headers],
            body: text.slice(0, SHOWN_BYTES),
            size: bytes,
            cut: bytes > SHOWN_BYTES,
            ms: Math.round(performance.now() - started),
          },
        });
      } catch (error) {
        // Refused by CORS, or no network: both a TypeError, and Tuti may get through either way.
        if (!(error instanceof TypeError)) throw error;
        await throughTuti("cors");
      }
    } finally {
      setSending(false);
    }
  }

  async function copy() {
    if ("error" in made) return;
    await navigator.clipboard.writeText(curlCommand({ method: made.method, url: made.url.href, headers: Object.fromEntries(made.headers), body: made.body }));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-1 border-b border-divider px-4 pt-4 pb-3 pr-12">
        <SheetTitle className="text-base">Try it</SheetTitle>
        <SheetDescription className="sr-only">Send a request to {operation.title}, with your own key.</SheetDescription>
        <p className="flex min-w-0 items-baseline gap-2 font-mono text-xs">
          <span className="shrink-0 font-semibold">{operation.kind}</span>
          <span className="min-w-0 break-all text-muted-foreground">{"url" in made ? made.url.href : operation.path}</span>
        </p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
        {(servers.length > 1 || chosen.variables) && (
          <Group title="Server">
            {servers.length > 1 && (
              // The group's heading names it.
              <select aria-label="Server" className={field} value={server} onChange={(event) => setServer(event.target.value)}>
                {servers.map((s) => (
                  <option key={s.url} value={s.url}>
                    {s.description ? `${s.description} (${s.url})` : s.url}
                  </option>
                ))}
              </select>
            )}
            {Object.entries(chosen.variables ?? {}).map(([name, variable]) => (
              <Labelled key={name} label={name} mono>
                {(id) =>
                  variable.enum?.length ? (
                    <select id={id} className={field} value={variables[name] ?? variable.default} onChange={(event) => setVariables({ ...variables, [name]: event.target.value })}>
                      {variable.enum.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  ) : (
                    <Input id={id} value={variables[name] ?? variable.default} onChange={(event) => setVariables({ ...variables, [name]: event.target.value })} />
                  )
                }
              </Labelled>
            ))}
          </Group>
        )}
        {schemes.length > 0 && (
          <Group title="Authorization" note={`Kept in this tab until you close it.${optional ? " Optional for this request." : ""}`}>
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
            <Textarea aria-label="Body" spellCheck={false} rows={10} className="font-mono text-xs" value={body} onChange={(event) => setBody(event.target.value)} />
          </Group>
        )}
        {result && <Answer result={result} />}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-divider px-4 py-3">
        <Button variant="outline" disabled={"error" in made} onClick={() => void copy()}>
          {copied ? "Copied" : "Copy as cURL"}
        </Button>
        <Button disabled={sending} onClick={() => void send()}>
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

/** The answer: its status, time and size, its headers (closed), and its body. Or why it wasn't sent. */
function Answer({ result }: { result: Result }) {
  const through =
    result.via === "cors"
      ? "Sent through Tuti, since the API doesn't allow browser requests."
      : result.via === "cookies"
        ? "Sent through Tuti, since browsers don't send cookies to another site."
        : null;
  return (
    <section aria-label="Response" aria-live="polite" className="flex flex-col gap-2 border-t border-divider pt-4">
      <h3 className="text-sm font-semibold">Response</h3>
      {"error" in result ? (
        <p role="alert" className="text-sm text-destructive">
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
          {result.answer.body && <pre className="max-h-96 overflow-auto rounded-lg bg-secondary p-3 font-mono text-xs whitespace-pre-wrap break-all">{pretty(result.answer)}</pre>}
        </>
      )}
      {through && <p className="text-[0.8125rem] text-muted-foreground">{through}</p>}
    </section>
  );
}
