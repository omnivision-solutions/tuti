import { expect, test, vi } from "vitest";

const codeChangesEnabled = vi.hoisted(() => vi.fn(() => true));
vi.mock("@tuti/shared", () => ({ codeChangesEnabled }));

const { default: Moved } = await import("./page");

/** Where the page redirects to and how (Next.js's redirect error: 308 is for good, 307 isn't). */
async function redirected(): Promise<[string, string]> {
  const error = await Moved({ params: Promise.resolve({ project: "acme" }), searchParams: Promise.resolve({}) }).catch((thrown: { digest?: string }) => thrown);
  const [, , url, status] = String((error as { digest?: string }).digest).split(";");
  return [url!, status!];
}

test("Settings → AI models' old address opens Autopilot's settings for good; where the server can't run Autopilot, AI answers for now", async () => {
  expect(await redirected()).toEqual(["/app/acme/settings/autopilot", "308"]);
  codeChangesEnabled.mockReturnValue(false);
  expect(await redirected()).toEqual(["/app/acme/settings/ai-answers", "307"]);
});
