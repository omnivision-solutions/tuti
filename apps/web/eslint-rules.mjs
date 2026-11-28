import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * The tRPC migration's rules (docs/plan.md, "One way in"), warnings until T12 makes them errors:
 * - `no-server-actions`: no `"use server"`, and no import of a `"use server"` module or of `operations/run.ts`. The list
 *   of files it warns on is what's left to move.
 * - `server-boundary`: pages, components, route handlers and `lib/` take from `@tuti/db` and `server/**` only
 *   `serverCaller`, operations, types and constants, so no read or write reaches the database without the check.
 */

const root = dirname(new URL(import.meta.url).pathname);
const src = join(root, "src");

/** The file an import names, if it's one of the app's own (`@/…` or relative). */
function resolveImport(from, specifier) {
  const base = specifier.startsWith("@/") ? join(src, specifier.slice(2)) : specifier.startsWith(".") ? resolve(dirname(from), specifier) : null;
  if (!base) {
    return null;
  }
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (/\.(ts|tsx)$/.test(candidate) && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

const directives = new Map();
/** Whether a file starts with `"use server"`. */
function isServerActions(file) {
  if (!directives.has(file)) {
    directives.set(file, /^\s*["']use server["']/.test(readFileSync(file, "utf8")));
  }
  return directives.get(file);
}

const typeOnly = (node) => node.importKind === "type" || (node.specifiers.length > 0 && node.specifiers.every((specifier) => specifier.importKind === "type"));

const noServerActions = {
  meta: { type: "problem", schema: [] },
  create(context) {
    const file = context.filename;
    const report = (node, message) => context.report({ node, message });
    return {
      ExpressionStatement(node) {
        if (node.directive === "use server") {
          report(node, 'No "use server": a server action\'s ID changes with every build. Call the operation through tRPC (docs/plan.md, "One way in").');
        }
      },
      ImportDeclaration(node) {
        if (typeOnly(node)) {
          return;
        }
        const target = resolveImport(file, node.source.value);
        if (!target) {
          return;
        }
        if (relative(src, target) === join("server", "operations", "run.ts")) {
          report(node, "operations/run.ts goes in T12: read through serverCaller(), save through tRPC, run another operation with runOperation, and test with the caller helper in src/test/helpers.ts.");
        } else if (isServerActions(target)) {
          report(node, `${relative(src, target)} is a "use server" module: call the operation through tRPC instead (docs/plan.md, "One way in").`);
        }
      },
    };
  },
};

/** Named in the warning: what only trusted server code calls. */
const OPERATION_INTERNALS = new Set(["runOperation", "legacyRun", "procedureFor", "authorize", "checked"]);

/**
 * Exempt by name, each for its reason, and only for the imports it names (docs/plan.md, "One way in"): the routes that
 * serve operations, the routes left as they are, signing in itself, and proxy.ts's gate and routing reads.
 */
const EXEMPT = [
  // Serve operations rather than call them: REST, MCP, the spec, the API docs.
  { files: /^src\/app\/api\/(v1|mcp|docs)\//, imports: /^server\/(api-auth|operations\/.+|trpc\/context)\.ts$/ },
  // Routes that stay routes (T10) acting for the team: the caller from the context function (the cookie session), then
  // createCaller. Autopilot's email buttons.
  { files: /^src\/app\/app\/\(workspace\)\/\[project\]\/autopilot\/\[id\]\/act\/route\.ts$/, imports: /^server\/(session|trpc\/context)\.ts$/ },
  // Routes that stay routes (T10): the GitHub connect flow keeps its guards against other sites (the same-site check,
  // the signed state and cookies, server/github-connect.ts); who may connect is the router's.
  { files: /^src\/app\/api\/github\/(install|setup|use|callback)\/route\.ts$/, imports: /^server\/github-connect\.ts$/ },
  // Left as they are: the job endpoints, the public widget feed, signed email links, webhooks, health, widget.js, media,
  // plans, the licence refresh, AppSumo's redirect, the sign-in card.
  {
    files:
      /^src\/app\/(api\/(autopilot\/due|inbox\/due|widget\/latest|stripe\/webhook|github\/webhook|appsumo\/webhook|appsumo\/redirect|email\/events|inbound\/email|health|widget\.js|media|plans|license\/refresh)\/|portal\/\[project\]\/\(site\)\/(changelog\/subscription\/(confirm|emails-on|unsubscribe)|unsubscribe\/confirm)\/|app\/\(account-pages\)\/auth\/card\.png\/)/,
    imports: /./,
  },
  // Routes that stay routes (T10): the caller from the context function (the cookie session, and until T11 the mobile
  // app's token as api-auth.ts reads it), then createCaller; the streams also need the stream itself.
  { files: /^src\/app\/api\/live\/route\.ts$/, imports: /^server\/(api-auth|live|session|trpc\/context)\.ts$/ },
  // Signing in itself, built from server/auth: Better Auth's handler and the hand-offs on both sides.
  { files: /^src\/app\/(api\/auth\/|portal\/\[project\]\/\(site\)\/(continue|sso)\/route\.ts$|app\/\(account-pages\)\/auth\/continue\/page\.tsx$)/, imports: /^server\/auth\// },
  // proxy.ts: its gate in front of a private portal (the reader and team function, server/auth/portal-readers.ts) and
  // its routing reads.
  {
    files: /^src\/proxy\.ts$/,
    imports: /^server\/(custom-domains|docs-queries|portal-redirects|language-addresses|auth\/portal-readers|auth\/preview-session)\.ts$/,
  },
];

const serverBoundary = {
  meta: { type: "problem", schema: [] },
  create(context) {
    const file = relative(root, context.filename);
    if (!/^src\/(app|components|lib|hooks)\/|^src\/proxy\.ts$/.test(file) || /\.test\.tsx?$/.test(file)) {
      return {};
    }
    const exempt = (target) => EXEMPT.some((rule) => rule.files.test(file) && rule.imports.test(target));
    return {
      ImportDeclaration(node) {
        if (typeOnly(node)) {
          return;
        }
        const values = node.specifiers.filter((specifier) => specifier.importKind !== "type");
        if (node.source.value === "@tuti/db") {
          if (values.some((specifier) => specifier.imported?.name === "prisma") && !exempt("@tuti/db")) {
            context.report({ node, message: "No Prisma here: read through serverCaller() and save through tRPC, so every read and write is checked." });
          }
          return;
        }
        const target = resolveImport(context.filename, node.source.value);
        const path = target && relative(src, target);
        // operations/run.ts and "use server" modules: no-server-actions says so.
        if (!path?.startsWith("server/") || path === join("server", "operations", "run.ts") || isServerActions(target) || exempt(path)) {
          return;
        }
        if (path === join("server", "trpc", "server.ts")) {
          return;
        }
        // From operations: their types and constants (MAX_AI_NAME), never a run or a helper that reads the database.
        if (path.startsWith(join("server", "operations") + "/")) {
          const read = values.find((specifier) => specifier.type !== "ImportSpecifier" || !/^[A-Z][A-Z0-9_]*$/.test(specifier.imported?.name ?? ""));
          if (read) {
            const name = read.imported?.name ?? read.local.name;
            context.report({
              node,
              message: OPERATION_INTERNALS.has(name)
                ? `${name} is for trusted server code: call the operation through serverCaller() or tRPC.`
                : `${name}: only types and constants come from operations here. Read through serverCaller() and save through tRPC.`,
            });
          }
          return;
        }
        context.report({ node, message: `${path} is the server layer: read through serverCaller() and save through tRPC (a pure helper moves to lib/).` });
      },
    };
  },
};

export const tuti = { rules: { "no-server-actions": noServerActions, "server-boundary": serverBoundary } };
