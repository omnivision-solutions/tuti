import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Pages and layouts (src/app; components and server helpers a render calls are not checked): once a request closes, after() turns the rest of every render that called it
  // to its "after" phase, where headers() and cookies() throw (a reader who left as a page loaded: errors in the server's log).
  {
    files: ["src/app/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "next/server",
              importNames: ["after"],
              message:
                "Not in renders: once the request closes, the rest of the render throws on headers() and cookies(). Start the task unawaited instead, `void task().catch((error) => log.error(…))`, as instrumentation.ts does.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
