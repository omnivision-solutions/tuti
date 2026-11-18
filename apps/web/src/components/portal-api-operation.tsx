import { ARTICLE_TITLE_ID, type Doc, MAX_CODE_TABS, toPlainText } from "@tuti/content";
import { RichText } from "@tuti/content/react";
import { type ApiAuth, type ApiOperation, type ApiParam, type ApiProperty, type ApiResponse, type ApiSchema, requestExamples, serverAddress, tryable } from "@tuti/shared/api-reference";
import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment, type ReactNode } from "react";

import { CodeCopyButtons } from "@/components/code-copy-buttons";
import { TryIt } from "@/components/portal-api-try";
import { DocsLayout, LockedMessage } from "@/components/portal-docs";
import { cn } from "@/lib/utils";
import { type ApiReferencePage, apiReferencePage, firstLine, markdownDoc } from "@/server/api-reference-queries";
import { docsContents, type DocsTree, docsTree } from "@/server/docs-queries";
import { portalLinks } from "@/server/portal-base";

type Reference = Extract<ApiReferencePage, { kind: "reference" }>;

/**
 * A method's colour, in hues the portal keeps whatever the project's accent (statuses', info blue, destructive red): the
 * accent itself isn't for labels. Reading in the Planned status's blue, adding in the Completed status's green, changing in orange, deleting in red.
 */
const METHOD_COLOUR: Partial<Record<ApiOperation["kind"], string>> = {
  GET: "text-status-planned",
  POST: "text-status-completed",
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
 * The reference's part of the docs' tree, as the team set it to sit there: its page ("Overview"), then each group a
 * folder (the current operation's open), each group a heading over its operations, or the reference as one entry
 * that opens to them. The tab's other references (`references`, the tree's) are a link each. `current`: the
 * operation's slug, null on the reference's own page.
 */
async function ReferenceTree({ page, references, current }: { page: Reference; references: DocsTree["references"]; current: string | null }) {
  const at = await portalLinks();
  const { reference, groups, operations } = page;
  const rest = "rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:text-foreground";
  const byGroup = Map.groupBy(operations, (operation) => operation.group);
  const inGroup = (key: string) => (
    <ul className="flex flex-col gap-0.5">
      {(byGroup.get(key) ?? []).map((operation) => (
          <li key={operation.slug}>
            <Link
              href={at(`/docs/${reference.slug}/${operation.slug}`)}
              title={operation.title}
              aria-current={operation.slug === current ? "page" : undefined}
              className={cn(rest, "flex items-center justify-between gap-2 aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground")}
            >
              <span className={cn("min-w-0 break-words", operation.deprecated && "line-through")}>
                {operation.title}
                {/* The line through it isn't read out. */}
                {operation.deprecated && <span className="sr-only"> (deprecated)</span>}
              </span>
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
  const overview = (
    <Link
      key="overview"
      href={at(`/docs/${reference.slug}`)}
      aria-current={current === null ? "page" : undefined}
      className={cn(rest, "aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground")}
    >
      Overview
    </Link>
  );
  const headings = groups.map((group) => (
    <div key={group.key} role="group" aria-label={group.name} className="flex flex-col gap-0.5">
      <p className="px-2.5 pt-2 pb-1 text-[0.8125rem] font-medium break-words">{group.name}</p>
      {inGroup(group.key)}
    </div>
  ));
  const own =
    reference.treeStyle === "FOLDERS"
      ? [overview, ...groups.map((group) => folder(group.key, group.name, group.key === open, inGroup(group.key)))]
      : reference.treeStyle === "HEADINGS"
        ? [overview, ...headings]
        : folder(
            reference.slug,
            reference.name,
            true,
            <div className="flex flex-col gap-0.5">
              {overview}
              {headings}
            </div>,
          );
  // Itself in its place among them; last, should the tree not have it.
  const listed = references.some((other) => other.slug === reference.slug) ? references : [...references, reference];
  return listed.map((other) =>
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
 * is one of them. A way that needs a scheme the reference doesn't show (digest, mutual TLS) is left out whole: named
 * by the rest of its schemes, it would read as if they were enough. Nothing for an operation with no way left: it needs
 * none, or only ones that can't be described, and the shape doesn't say which, so the page never says "none needed".
 */
function Signing({ operation, schemes }: { operation: ApiOperation; schemes: ApiAuth[] }) {
  const ways = operation.auth
    .filter((keys) => keys.length > 0)
    .map((keys) => keys.map((key) => schemes.find((scheme) => scheme.key === key)))
    .filter((way): way is ApiAuth[] => way.every((scheme) => scheme !== undefined));
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

/** The values an array holds, when they're plain ones (no fields or shapes of their own): an array of arrays', the innermost. */
function plainItems(schema: ApiSchema): ApiSchema | null {
  let item = schema.items;
  while (item?.items) {
    item = item.items;
  }
  return item && !inside(item) ? item : null;
}

/** The values a schema may be. */
function Allowed({ label, values }: { label: string; values: unknown[] | undefined }) {
  return (
    values &&
    values.length > 0 && (
      <p className="flex flex-wrap items-center gap-1.5 text-[0.8125rem] text-muted-foreground">
        {label}
        {values.map((value, i) => (
          <Value key={i}>{literal(value)}</Value>
        ))}
      </p>
    )
  );
}

/**
 * What a schema says about its own value, under its name and type: its description, default and allowed values, and
 * for an array of plain values what each item is held to. A field's, and a body's or response's own (one that's an
 * array of strings or a plain value has nothing else to show).
 */
function Details({ schema, description }: { schema: ApiSchema; description?: string }) {
  const item = plainItems(schema);
  const limits = item && [item.format, item.nullable && "nullable", item.constraints].filter(Boolean).join(" · ");
  return (
    <>
      <Markdown text={description || schema.description} className="gap-2 text-[0.9375rem] text-muted-foreground" />
      {schema.default !== undefined && (
        <p className="text-[0.8125rem] text-muted-foreground">
          Default: <Value>{literal(schema.default)}</Value>
        </p>
      )}
      <Allowed label="One of" values={schema.enum} />
      {limits && <p className="text-[0.8125rem] text-muted-foreground">Each item: {limits}</p>}
      <Markdown text={item?.description} className="gap-2 text-[0.9375rem] text-muted-foreground" />
      <Allowed label="Each item one of" values={item?.enum} />
    </>
  );
}

/** A schema's type in words, with its format and limits. */
const typeLine = (schema: ApiSchema) => [schema.type, schema.format, schema.nullable && "nullable", schema.constraints];

/** A body's or a response's schema: what it says of itself, then its fields. */
function Root({ schema }: { schema: ApiSchema }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Details schema={schema} />
      <Fields schema={schema} />
    </div>
  );
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
          {typeLine(schema).filter(Boolean).join(" · ")}
        </span>
        {required && <span className="text-xs font-medium text-muted-foreground">required</span>}
        {schema.deprecated && <span className="text-xs font-medium text-muted-foreground">deprecated</span>}
      </div>
      <Details schema={schema} description={description} />
      {within && (
        // Its own toggle only ([open]>summary>): a named group would follow any open field it's in.
        <details>
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-sm font-medium text-primary hover:underline [&::-webkit-details-marker]:hidden">
            <span className="[[open]>summary>&]:hidden">Show</span>
            <span className="hidden [[open]>summary>&]:inline">Hide</span> {count} {what}
            <ChevronRightIcon aria-hidden className="size-3.5 transition-transform [[open]>summary>&]:rotate-90" />
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

/** A status's dot: the Completed status's green for success, orange for the caller's mistakes, red for the server's. */
const statusColour = (status: string) =>
  status.startsWith("2") ? "bg-status-completed" : status.startsWith("4") ? "bg-status-in-progress" : status.startsWith("5") ? "bg-destructive" : "bg-muted-foreground";

/** Code blocks as RichText shows an article's (tabs without scripts, and CodeCopyButtons' Copy): `tabs`, or one labelled block. */
function codeDoc(tabs: { name: string; code: string }[]): Doc {
  const blocks = tabs.map(({ name, code }) => ({ type: "codeBlock", attrs: { filename: name }, content: code ? [{ type: "text", text: code }] : [] }));
  return { type: "doc", content: blocks.length > 1 ? [{ type: "codeTabs", content: blocks }] : blocks };
}

/**
 * A response's example as it's sent: JSON under a JSON content type (a string in its quotes), else text as it is.
 * JSON is application/json and the "+json" types: lines of JSON (application/x-ndjson, jsonl) are text, a line each.
 */
const exampleText = (example: unknown, contentType: string | null) =>
  typeof example === "string" && !/^application\/json\s*(;|$)|\+json\s*(;|$)/i.test(contentType ?? "") ? example : JSON.stringify(example, null, 2);

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
    .map((response) => ({ name: response.status === "data" ? "Response" : response.status, code: exampleText(response.example, response.contentType) }));
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

/**
 * A response: its status and description, opening to its schema when it has one. The description is Markdown. A row
 * that opens has it as words alone in its summary (a link inside a control that toggles couldn't be followed by
 * itself), and whole, links and all, once it's open, when it has a link.
 */
async function ResponseRow({ response }: { response: ApiResponse }) {
  const description = response.description.trim() ? await markdownDoc(response.description) : null;
  const text = "gap-2 text-[0.9375rem]";
  const status = (
    <>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", statusColour(response.status))} />
      <code className="font-mono text-sm font-semibold">{response.status}</code>
    </>
  );
  return (
    <li className="border-t border-divider">
      {response.schema ? (
        <details className="group/response">
          <summary className="flex cursor-pointer list-none items-center gap-2.5 py-3 [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-open/response:rotate-90" />
            {status}
            {description && <span className="min-w-0 text-[0.9375rem] break-words">{toPlainText(description)}</span>}
          </summary>
          <div className="flex flex-col gap-2 pb-3 pl-6.5">
            {description && JSON.stringify(description).includes('"type":"link"') && <RichText doc={description} className={cn("rich-text break-words", text)} />}
            <p className="text-[0.8125rem] text-muted-foreground">{[response.contentType, ...typeLine(response.schema)].filter(Boolean).join(" · ")}</p>
            <Root schema={response.schema} />
          </div>
        </details>
      ) : (
        <div className="flex items-baseline gap-2.5 py-3 pl-6.5">
          {status}
          {description && <RichText doc={description} className={cn("rich-text min-w-0 break-words", text)} />}
        </div>
      )}
    </li>
  );
}

/** The path with each parameter marked. */
function Path({ path }: { path: string }) {
  return (
    <code className="min-w-0 font-mono text-sm font-medium break-all">
      {path.split(/(\{[^{}]+\})/).map((part, i) =>
        i % 2 ? (
          <span key={i} className="rounded-sm bg-secondary px-1 py-px">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </code>
  );
}

/** The reference's tab's tree: its collections (in no tab: the first tab's, or all of the docs without tabs); never another tab's. */
async function tabTree(project: string, page: Reference) {
  const docs = await docsContents(project);
  const tab = page.tab ?? docs.home;
  return tab === null || docs.tabs.some((t) => t.slug === tab) ? docsTree(docs, tab, null) : { collections: [], uncollected: [], references: [] };
}

/**
 * An operation's page (/docs/<reference>/<operation>): the tab's tree with the reference's operations,
 * what the operation is and takes and answers, and beside it (under it below desktop width) its
 * examples. GraphQL's is the plain version: its arguments, and the query to send.
 */
export async function ApiOperationPage({ project, page, operation }: { project: string; page: Reference; operation: ApiOperation }) {
  const at = await portalLinks();
  const tree = await tabTree(project, page);
  const group = page.groups.find((g) => g.key === operation.group);
  const openapi = page.doc.format === "openapi";
  return (
    <DocsLayout tree={tree} current={null} wide extra={<ReferenceTree page={page} references={tree.references} current={operation.slug} />}>
      <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1fr)_26rem] xl:items-start">
        <article className="flex min-w-0 flex-col gap-8" aria-labelledby={ARTICLE_TITLE_ID}>
          <div className="flex flex-col gap-3">
            <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
              <Link href={at(`/docs/${page.reference.slug}`)} className="truncate hover:text-foreground">
                {page.reference.name}
              </Link>
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
            {operation.deprecated && <span className="w-fit rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">Deprecated</span>}
            <Markdown text={operation.description} className="article-text gap-4 text-foreground" />
            <div className="mt-1 flex items-center gap-3 rounded-xl bg-card px-4 py-3 shadow-card ring-1 ring-card-edge">
              <Method kind={operation.kind} />
              <Path path={operation.path} />
              {/* Only while the team lets readers try requests (Settings' Try it; the proxy refuses them too), and where there's
                  somewhere to send it: never GraphQL (yet), nor servers without a host and no base address. */}
              {page.reference.tryIt && tryable(page.doc, operation, page.reference.baseUrl) && (
                <TryIt
                  // One per operation. Next.js already mounts each operation's page afresh (it keys a page by its route's
                  // params); this keeps a console's fields, answer and request on its way to its own operation should that change.
                  key={`${page.reference.slug}/${operation.slug}`}
                  reference={page.reference.slug}
                  operationSlug={operation.slug}
                  // What the console reads, not the whole spec: its servers, its ways of signing, this operation.
                  doc={{ ...page.doc, groups: [], operations: [], types: [], warnings: [], description: "" }}
                  operation={{ ...operation, responses: [], description: "" }}
                  base={page.reference.baseUrl}
                />
              )}
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
            <Section title="Body" note={[operation.body.contentType, ...typeLine(operation.body.schema), operation.body.required && "required"].filter(Boolean).join(" · ")}>
              <Root schema={operation.body.schema} />
            </Section>
          )}
          {openapi && operation.responses.length > 0 && (
            <Section title="Responses">
              <ul className="mt-2 flex flex-col">
                {operation.responses.map((response) => (
                  <ResponseRow key={response.status} response={response} />
                ))}
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

/**
 * An operation (`title`), or without one the reference itself, in a tab this reader may not read but sees with a lock:
 * its title, and what to do, as a locked article's page.
 */
export function LockedOperation({ page, title }: { page: Extract<ApiReferencePage, { kind: "locked" }>; title?: string }) {
  return (
    <DocsLayout tree={null} current={null}>
      <article className="flex flex-col gap-6" aria-labelledby={ARTICLE_TITLE_ID}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{title === undefined ? "API reference" : page.reference.name}</p>
          <h1 id={ARTICLE_TITLE_ID} className="font-heading text-[1.75rem] leading-[1.15] font-[650] tracking-[-0.025em] break-words sm:text-[2.25rem]">
            {title ?? page.reference.name}
          </h1>
        </div>
        <LockedMessage signedIn={page.signedIn} />
      </article>
    </DocsLayout>
  );
}

/** How many operations a group's card names before "+ N more". */
const CARD_OPERATIONS = 3;

/** One of the overview's two boxes: a small label over a list. */
function Box({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-3 rounded-xl bg-card p-5 shadow-card ring-1 ring-card-edge">
      <h2 className="font-sans text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h2>
      <ul className="flex flex-col gap-4">{children}</ul>
    </section>
  );
}

/**
 * A reference's own page (/docs/<reference>, or a tab's address when it holds the reference alone): its name, version
 * and description, where requests go, how they're signed, and a card per group in the team's order with a few of its
 * operations. Only what's on the help center: the groups and operations `onHelpCenter` gives, and the ways of signing
 * they use.
 */
export async function ApiReferenceOverview({ project, page }: { project: string; page: Reference }) {
  const at = await portalLinks();
  const tree = await tabTree(project, page);
  const { doc, reference, groups, operations } = page;
  const openapi = doc.format === "openapi";
  const byGroup = Map.groupBy(operations, (operation) => operation.group);
  const used = new Set(operations.flatMap((operation) => operation.auth.flat()));
  const schemes = doc.auth.filter((scheme) => used.has(scheme.key));
  // The spec's servers and the shown operations' own, each address once; with none for the whole spec, the base or the
  // examples' placeholder (`undefined`) too where an operation goes without one of its own.
  const listed = [...new Map([...doc.servers, ...operations.flatMap((operation) => operation.servers ?? [])].map((server) => [server.url, server])).values()];
  const servers = [...listed, ...(doc.servers.length === 0 && operations.some((operation) => !operation.servers?.length) ? [undefined] : [])];
  const descriptions = new Map(await Promise.all(groups.map(async (group) => [group.key, await firstLine(group.description)] as const)));
  return (
    <DocsLayout tree={tree} current={null} wide extra={<ReferenceTree page={page} references={tree.references} current={null} />}>
      <article className="flex min-w-0 flex-col gap-8" aria-labelledby={ARTICLE_TITLE_ID}>
        <div className="flex flex-col gap-3">
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            API reference
            <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
              {[doc.version && `Version ${doc.version}`, openapi ? "OpenAPI" : "GraphQL"].filter(Boolean).join(" · ")}
            </span>
          </p>
          <h1 id={ARTICLE_TITLE_ID} className="font-heading text-[1.75rem] leading-[1.15] font-[650] tracking-[-0.025em] break-words sm:text-[2.25rem]">
            {reference.name}
          </h1>
          <Markdown text={doc.description} className="article-text gap-4 text-muted-foreground" />
        </div>
        <div className={cn("grid gap-4", schemes.length > 0 && "lg:grid-cols-2")}>
          <Box title="Where requests go">
            {servers.map((server, i) => {
              const address = serverAddress(server, reference.baseUrl ?? undefined);
              return (
                <li key={i} className="flex min-w-0 flex-col gap-1.5">
                  <code className="font-mono text-sm break-all">{address.url}</code>
                  <Markdown text={server?.description} className="gap-2 text-sm text-muted-foreground" />
                  {Object.entries(server?.variables ?? {}).map(([name, variable]) => (
                    <div key={name} className="flex flex-col gap-1 text-[0.8125rem] text-muted-foreground">
                      <p className="flex flex-wrap items-center gap-1.5">
                        <Value>{`{${name}}`}</Value>
                        Default <Value>{variable.default}</Value>
                      </p>
                      <Allowed label="One of" values={variable.enum} />
                      <Markdown text={variable.description} className="gap-2" />
                    </div>
                  ))}
                  {address.placeholder && <p className="text-[0.8125rem] text-muted-foreground">A placeholder: the spec doesn&apos;t say which host this is on.</p>}
                </li>
              );
            })}
          </Box>
          {schemes.length > 0 && (
            <Box title="How requests are signed">
              {schemes.map((scheme) => (
                <li key={scheme.key} className="flex min-w-0 flex-col gap-1.5">
                  <p className="text-sm text-foreground">
                    {authLabel(scheme)}
                    {scheme.kind !== "header" && scheme.kind !== "query" && scheme.kind !== "cookie" && (
                      <>
                        {" "}
                        in the <code className="font-mono text-[0.9em]">{scheme.name}</code> header
                      </>
                    )}
                  </p>
                  <Markdown text={scheme.description} className="gap-2 text-sm text-muted-foreground" />
                </li>
              ))}
            </Box>
          )}
        </div>
        <section aria-labelledby="reference-groups" className="flex flex-col gap-4">
          <h2 id="reference-groups" className="font-sans text-lg font-[650] tracking-[-0.01em]">
            {openapi ? "Endpoints" : "Operations"}
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {groups.map((group) => {
              const inGroup = byGroup.get(group.key) ?? [];
              const more = inGroup.length - CARD_OPERATIONS;
              return (
                <li key={group.key} className="flex min-w-0 flex-col gap-1 rounded-xl bg-card p-5 shadow-card ring-1 ring-card-edge">
                  <h3 className="font-sans text-[1.0625rem] font-semibold break-words">{group.name}</h3>
                  {descriptions.get(group.key) && <p className="line-clamp-2 text-[0.9375rem] break-words text-muted-foreground">{descriptions.get(group.key)}</p>}
                  <ul className="mt-2 flex flex-col gap-1">
                    {inGroup.slice(0, CARD_OPERATIONS).map((operation) => (
                      <li key={operation.slug}>
                        <Link href={at(`/docs/${reference.slug}/${operation.slug}`)} className="flex min-w-0 items-baseline gap-2 text-[0.9375rem] hover:underline">
                          {openapi && <Method kind={operation.kind} />}
                          <span className={cn("min-w-0 break-words", operation.deprecated && "line-through")}>
                            {operation.title}
                            {operation.deprecated && <span className="sr-only"> (deprecated)</span>}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                  {more > 0 && <p className="mt-1 text-sm text-muted-foreground">+ {more} more</p>}
                </li>
              );
            })}
          </ul>
        </section>
      </article>
    </DocsLayout>
  );
}

/** Reference `slug`'s page for this reader (apiReferencePage): its overview, its name with a lock, or a 404. */
export async function ApiReferenceLanding({ project, slug }: { project: string; slug: string }) {
  const page = await apiReferencePage(project, slug);
  if (!page) {
    notFound();
  }
  return page.kind === "locked" ? <LockedOperation page={page} /> : <ApiReferenceOverview project={project} page={page} />;
}

/** A reference's search listing and link card (portalPageMetadata: the caller adds its path): its name; one for some readers only, or locked for this one, isn't for search engines. */
export async function referenceListing(project: string, slug: string) {
  const page = await apiReferencePage(project, slug);
  if (!page) {
    return null;
  }
  return page.kind === "locked"
    ? { title: page.reference.name, noindex: true }
    : { title: page.reference.name, description: await firstLine(page.doc.description), noindex: page.restricted };
}
