import { ARTICLE_TITLE_ID, type Doc, MAX_CODE_TABS } from "@tuti/content";
import { RichText } from "@tuti/content/react";
import { type ApiAuth, type ApiOperation, type ApiParam, type ApiProperty, type ApiSchema, requestExamples } from "@tuti/shared/api-reference";
import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";

import { CodeCopyButtons } from "@/components/code-copy-buttons";
import { DocsLayout, LockedMessage } from "@/components/portal-docs";
import { cn } from "@/lib/utils";
import { type ApiReferencePage, markdownDoc } from "@/server/api-reference-queries";
import { docsContents, docsTree } from "@/server/docs-queries";
import { portalLinks } from "@/server/portal-base";

type Reference = Extract<ApiReferencePage, { kind: "reference" }>;

/**
 * A method's colour: reading in blue, changing in orange, deleting in red (the portal's status hues), and adding in the
 * project's accent, never a green of Tuti's own on a team's portal.
 */
const METHOD_COLOUR: Partial<Record<ApiOperation["kind"], string>> = {
  GET: "text-status-planned",
  POST: "text-soft-foreground",
  PUT: "text-status-in-progress",
  PATCH: "text-status-in-progress",
  DELETE: "text-destructive",
};

/** An operation's method as a small coloured label (GraphQL's: "query", "mutation"). */
function Method({ kind, className }: { kind: ApiOperation["kind"]; className?: string }) {
  return <span className={cn("shrink-0 font-mono text-xs font-semibold tracking-wide uppercase", METHOD_COLOUR[kind] ?? "text-muted-foreground", className)}>{kind}</span>;
}

/** A spec's Markdown, through markdownDoc: never as markup. */
async function Markdown({ text, className }: { text: string | undefined; className?: string }) {
  if (!text?.trim()) {
    return null;
  }
  return <RichText doc={await markdownDoc(text)} className={cn("rich-text break-words", className)} />;
}

/**
 * The reference's part of the docs' tree, as the team set it to sit there: each group a folder (the
 * current operation's open), each group a heading over its operations, or the reference as one entry
 * that opens to them. The tab's other references are a link each.
 */
async function ReferenceTree({ page, current }: { page: Reference; current: string }) {
  const at = await portalLinks();
  const { reference, groups, operations } = page;
  const rest = "rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:text-foreground";
  const inGroup = (key: string) => (
    <ul className="flex flex-col gap-0.5">
      {operations
        .filter((operation) => operation.group === key)
        .map((operation) => (
          <li key={operation.slug}>
            <Link
              href={at(`/docs/${reference.slug}/${operation.slug}`)}
              title={operation.title}
              aria-current={operation.slug === current ? "page" : undefined}
              className={cn(rest, "flex items-center justify-between gap-2 aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground")}
            >
              <span className={cn("min-w-0 break-words", operation.deprecated && "line-through")}>{operation.title}</span>
              {/* GraphQL's groups already say which kind each is. */}
              {page.doc.format === "openapi" && <Method kind={operation.kind} />}
            </Link>
          </li>
        ))}
    </ul>
  );
  const open = operations.find((operation) => operation.slug === current)?.group;
  const folder = (key: string, name: string, isOpen: boolean, inside: ReactNode) => (
    <details key={key} open={isOpen} className="group/collection">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 font-medium hover:bg-muted [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 break-words">{name}</span>
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-open/collection:rotate-90" />
      </summary>
      <div className="my-1 ml-2.5">{inside}</div>
    </details>
  );
  const headings = groups.map((group) => (
    <div key={group.key} role="group" aria-label={group.name} className="flex flex-col gap-0.5">
      <p className="px-2.5 pt-2 pb-1 text-[0.8125rem] font-medium break-words">{group.name}</p>
      {inGroup(group.key)}
    </div>
  ));
  const own =
    reference.treeStyle === "FOLDERS"
      ? groups.map((group) => folder(group.key, group.name, group.key === open, inGroup(group.key)))
      : reference.treeStyle === "HEADINGS"
        ? headings
        : folder(reference.slug, reference.name, true, headings);
  return page.references.map((other) =>
    other.slug === reference.slug ? (
      <Fragment key={other.slug}>{own}</Fragment>
    ) : (
      <Link key={other.slug} href={at(`/docs/${other.slug}`)} title={other.name} className={cn(rest, "font-medium break-words text-foreground")}>
        {other.name}
      </Link>
    ),
  );
}

/** How one of the spec's ways of signing a request reads. */
function authLabel(auth: ApiAuth): ReactNode {
  const named = (what: string) => (
    <>
      API key in the <code className="font-mono text-[0.9em] text-foreground">{auth.name}</code> {what}
    </>
  );
  switch (auth.kind) {
    case "bearer":
      return "Bearer token";
    case "basic":
      return "Basic authentication";
    case "header":
      return named("header");
    case "query":
      return named("query parameter");
    case "cookie":
      return named("cookie");
    case "oauth2":
      return "OAuth 2.0";
    case "openIdConnect":
      return "OpenID Connect";
  }
}

/**
 * How the operation is signed: any one of its ways, each the schemes it needs together, and "or none" when unsigned
 * is one of them. Nothing for an operation with no way listed: it needs none, or only one the reference doesn't show
 * (digest, mutual TLS), and the shape doesn't say which, so the page never says "none needed".
 */
function Signing({ operation, schemes }: { operation: ApiOperation; schemes: ApiAuth[] }) {
  const ways = operation.auth.map((keys) => keys.flatMap((key) => schemes.find((scheme) => scheme.key === key) ?? [])).filter((way) => way.length > 0);
  if (ways.length === 0) {
    return null;
  }
  return (
    <p className="text-sm text-muted-foreground">
      <span className="font-medium text-foreground">Authorization</span>{" "}
      {ways.map((way, i) => (
        <Fragment key={i}>
          {i > 0 && " or "}
          {way.map((scheme, j) => (
            <Fragment key={scheme.key}>
              {j > 0 && " and "}
              {authLabel(scheme)}
            </Fragment>
          ))}
        </Fragment>
      ))}
      {operation.auth.some((keys) => keys.length === 0) && ", or none"}
    </p>
  );
}

/** A value from the spec as it's written in JSON ("open", 1, null). */
const literal = (value: unknown) => JSON.stringify(value) ?? String(value);

/** What a schema spells out under it: an object's fields, an array's items' fields, or the shapes it's one of. */
function inside(schema: ApiSchema): { properties: ApiProperty[] } | { oneOf: ApiSchema[] } | null {
  for (let at: ApiSchema | undefined = schema; at; at = at.items) {
    if (at.properties?.length) {
      return { properties: at.properties };
    }
    if (at.oneOf?.length) {
      return { oneOf: at.oneOf };
    }
  }
  return null;
}

/** A schema's fields, or its shapes each as a row. */
function Fields({ schema }: { schema: ApiSchema }) {
  const within = inside(schema);
  if (!within) {
    return null;
  }
  return (
    <ul className="flex flex-col">
      {"properties" in within
        ? within.properties.map((property) => <Field key={property.name} name={property.name} required={property.required} schema={property} />)
        : within.oneOf.map((option, i) => <Field key={i} name={`Option ${i + 1}`} schema={option} />)}
    </ul>
  );
}

/**
 * A parameter or a field: its name, type, limits and whether it's required, its description, default and
 * allowed values, and what's in it behind "Show properties" (as deep as the spec was read: two levels).
 * A named type is only named: types have no pages yet.
 */
function Field({ name, required = false, description, schema }: { name: string; required?: boolean; description?: string; schema: ApiSchema }) {
  const within = inside(schema);
  const count = within && ("properties" in within ? within.properties.length : within.oneOf.length);
  const what = within && ("properties" in within ? (count === 1 ? "property" : "properties") : count === 1 ? "option" : "options");
  return (
    <li className="flex flex-col gap-1.5 border-t border-divider py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <code className={cn("font-mono text-sm font-medium break-all", schema.deprecated && "line-through")}>{name}</code>
        <span className="text-[0.8125rem] break-words text-muted-foreground">
          {[schema.type, schema.format, schema.nullable && "nullable", schema.constraints].filter(Boolean).join(" · ")}
        </span>
        {required && <span className="text-xs font-medium text-highlight-foreground">required</span>}
        {schema.deprecated && <span className="text-xs font-medium text-muted-foreground">deprecated</span>}
      </div>
      <Markdown text={description || schema.description} className="gap-2 text-[0.9375rem] text-muted-foreground" />
      {schema.default !== undefined && (
        <p className="text-[0.8125rem] text-muted-foreground">
          Default: <Value>{literal(schema.default)}</Value>
        </p>
      )}
      {schema.enum && schema.enum.length > 0 && (
        <p className="flex flex-wrap items-center gap-1.5 text-[0.8125rem] text-muted-foreground">
          One of
          {schema.enum.map((value, i) => (
            <Value key={i}>{literal(value)}</Value>
          ))}
        </p>
      )}
      {within && (
        <details className="group/fields">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-sm font-medium text-primary hover:underline [&::-webkit-details-marker]:hidden">
            <span className="group-open/fields:hidden">Show</span>
            <span className="hidden group-open/fields:inline">Hide</span> {count} {what}
            <ChevronRightIcon aria-hidden className="size-3.5 transition-transform group-open/fields:rotate-90" />
          </summary>
          <div className="mt-2 ml-1 border-l border-divider pl-4">
            <Fields schema={schema} />
          </div>
        </details>
      )}
    </li>
  );
}

function Value({ children }: { children: ReactNode }) {
  return <code className="rounded-sm bg-secondary px-1.5 py-px font-mono text-xs break-all text-foreground">{children}</code>;
}

function Section({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col">
      <h2 className="font-sans text-lg font-[650] tracking-[-0.01em]">{title}</h2>
      {note && <p className="mt-1 mb-2 text-[0.8125rem] text-muted-foreground">{note}</p>}
      {children}
    </section>
  );
}

/** Where parameters go, in the order they're listed, and what each kind is called. */
const PLACES: [ApiParam["in"], string][] = [
  ["path", "Path parameters"],
  ["query", "Query parameters"],
  ["header", "Headers"],
  ["cookie", "Cookies"],
  ["argument", "Arguments"],
];

/** A status's dot: the project's accent for success, orange for the caller's mistakes, red for the server's. */
const statusColour = (status: string) =>
  status.startsWith("2") ? "bg-primary" : status.startsWith("4") ? "bg-status-in-progress" : status.startsWith("5") ? "bg-destructive" : "bg-muted-foreground";

/** Code blocks as RichText shows an article's (tabs without scripts, and CodeCopyButtons' Copy): `tabs`, or one labelled block. */
function codeDoc(tabs: { name: string; code: string }[]): Doc {
  const blocks = tabs.map(({ name, code }) => ({ type: "codeBlock", attrs: { filename: name }, content: code ? [{ type: "text", text: code }] : [] }));
  return { type: "doc", content: blocks.length > 1 ? [{ type: "codeTabs", content: blocks }] : blocks };
}

/** An example value as it's sent: JSON, or text as it is. */
const exampleText = (example: unknown) => (typeof example === "string" ? example : JSON.stringify(example, null, 2));

/** Beside the page: the request as cURL, JavaScript and Python, and each response's example by status. */
function Examples({ page, operation }: { page: Reference; operation: ApiOperation }) {
  const request = requestExamples(page.doc, operation, { base: page.reference.baseUrl ?? undefined });
  const requests = [
    { name: "cURL", code: request.curl },
    { name: "JavaScript", code: request.javascript },
    { name: "Python", code: request.python },
  ];
  const responses = operation.responses
    .filter((response) => response.example !== undefined)
    // ponytail: the tabs' styles show eight (MAX_CODE_TABS); a ninth status's example is in no tab, its fields still under Responses.
    .slice(0, MAX_CODE_TABS)
    .map((response) => ({ name: response.status === "data" ? "Response" : response.status, code: exampleText(response.example) }));
  return (
    <>
      <div className="flex min-w-0 flex-col gap-4">
        <section aria-label="Request example">
          <RichText doc={codeDoc(requests)} className="rich-text article-text" />
        </section>
        {responses.length > 0 && (
          <section aria-label="Response example">
            <RichText doc={codeDoc(responses)} className="rich-text article-text" />
          </section>
        )}
      </div>
      <CodeCopyButtons />
    </>
  );
}

/** The path with each parameter marked. */
function Path({ path }: { path: string }) {
  return (
    <code className="min-w-0 font-mono text-sm font-medium break-all">
      {path.split(/(\{[^{}]+\})/).map((part, i) =>
        i % 2 ? (
          <span key={i} className="rounded-sm bg-soft px-1 py-px text-soft-foreground">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </code>
  );
}

/**
 * An operation's page (/docs/<reference>/<operation>): the tab's tree with the reference's operations,
 * what the operation is and takes and answers, and beside it (under it below desktop width) its
 * examples. GraphQL's is the plain version: its arguments, and the query to send.
 */
export async function ApiOperationPage({ project, page, operation }: { project: string; page: Reference; operation: ApiOperation }) {
  const docs = await docsContents(project);
  // Its tab's collections (in no tab: the first tab's, or all of the docs without tabs). A tab with nothing else to read
  // isn't among the docs' tabs, and has none: never another tab's.
  const tab = page.tab ?? docs.home;
  const tree = tab === null || docs.tabs.some((t) => t.slug === tab) ? docsTree(docs, tab, null) : { collections: [], uncollected: [] };
  const group = page.groups.find((g) => g.key === operation.group);
  const openapi = page.doc.format === "openapi";
  return (
    <DocsLayout tree={tree} current={null} wide extra={<ReferenceTree page={page} current={operation.slug} />}>
      <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1fr)_26rem] xl:items-start">
        <article className="flex min-w-0 flex-col gap-8" aria-labelledby={ARTICLE_TITLE_ID}>
          <div className="flex flex-col gap-3">
            <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
              <span className="truncate">{page.reference.name}</span>
              {group && (
                <>
                  <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
                  <span className="truncate font-medium text-foreground">{group.name}</span>
                </>
              )}
            </p>
            <h1 id={ARTICLE_TITLE_ID} className="font-heading text-[1.75rem] leading-[1.15] font-[650] tracking-[-0.025em] break-words sm:text-[2.25rem]">
              {operation.title}
            </h1>
            {operation.deprecated && <span className="w-fit rounded-full bg-highlight px-2 py-0.5 text-xs font-medium text-highlight-foreground">Deprecated</span>}
            <Markdown text={operation.description} className="article-text gap-4 text-foreground" />
            <div className="mt-1 flex items-center gap-3 rounded-xl bg-card px-4 py-3 shadow-card ring-1 ring-card-edge">
              <Method kind={operation.kind} />
              <Path path={operation.path} />
            </div>
            {openapi && <Signing operation={operation} schemes={page.doc.auth} />}
          </div>
          {PLACES.map(([place, title]) => {
            const params = operation.params.filter((param) => param.in === place);
            return (
              params.length > 0 && (
                <Section key={place} title={title}>
                  <ul className="mt-2 flex flex-col">
                    {params.map((param) => (
                      <Field key={param.name} name={param.name} required={param.required} description={param.description} schema={param.schema} />
                    ))}
                  </ul>
                </Section>
              )
            );
          })}
          {operation.body && (
            <Section title="Body" note={[operation.body.contentType, operation.body.schema.type, operation.body.required && "required"].filter(Boolean).join(" · ")}>
              <Fields schema={operation.body.schema} />
            </Section>
          )}
          {openapi && operation.responses.length > 0 && (
            <Section title="Responses">
              <ul className="mt-2 flex flex-col">
                {operation.responses.map((response) => {
                  const row = (
                    <>
                      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", statusColour(response.status))} />
                      <code className="font-mono text-sm font-semibold">{response.status}</code>
                      <span className="min-w-0 text-[0.9375rem] break-words">{response.description}</span>
                    </>
                  );
                  return (
                    <li key={response.status} className="border-t border-divider">
                      {response.schema ? (
                        <details className="group/response">
                          <summary className="flex cursor-pointer list-none items-center gap-2.5 py-3 [&::-webkit-details-marker]:hidden">
                            <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-open/response:rotate-90" />
                            {row}
                          </summary>
                          <div className="pb-3 pl-6.5">
                            <p className="mb-2 text-[0.8125rem] text-muted-foreground">{[response.contentType, response.schema.type].filter(Boolean).join(" · ")}</p>
                            <Fields schema={response.schema} />
                          </div>
                        </details>
                      ) : (
                        <div className="flex items-center gap-2.5 py-3 pl-6.5">{row}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}
        </article>
        <div className="flex min-w-0 flex-col xl:sticky xl:top-[calc(var(--portal-header-height,0px)+1.5rem)] xl:max-h-[calc(100dvh-var(--portal-header-height,0px)-3rem)] xl:overflow-y-auto">
          <Examples page={page} operation={operation} />
        </div>
      </div>
    </DocsLayout>
  );
}

/** An operation in a tab this reader may not read but sees with a lock: its title, and what to do, as a locked article's page. */
export function LockedOperation({ page, title }: { page: Extract<ApiReferencePage, { kind: "locked" }>; title: string }) {
  return (
    <DocsLayout tree={null} current={null}>
      <article className="flex flex-col gap-6" aria-labelledby={ARTICLE_TITLE_ID}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{page.reference.name}</p>
          <h1 id={ARTICLE_TITLE_ID} className="font-heading text-[1.75rem] leading-[1.15] font-[650] tracking-[-0.025em] break-words sm:text-[2.25rem]">
            {title}
          </h1>
        </div>
        <LockedMessage signedIn={page.signedIn} />
      </article>
    </DocsLayout>
  );
}
