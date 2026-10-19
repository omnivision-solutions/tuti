import { appUrl } from "@/lib/hosts";
import { openApiSpec } from "@/server/operations/openapi";

// The API's description (OpenAPI 3.1), public: it lists what the API offers, never data.
export function GET() {
  return Response.json(openApiSpec(`${appUrl().origin}/api/v1`), {
    headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" },
  });
}
