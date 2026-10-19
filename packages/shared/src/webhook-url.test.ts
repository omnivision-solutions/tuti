import { afterEach, expect, test, vi } from "vitest";

import { checkWebhookUrl, publicOnlyLookup } from "./webhook-url";

/** Fixed DNS answers, so no test depends on the machine's resolver or the network. */
const ANSWERS: Record<string, { address: string; family: number }[]> = {
  "internal.test": [{ address: "10.0.0.5", family: 4 }],
  "mixed.test": [
    { address: "93.184.215.14", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ],
  "public.test": [{ address: "93.184.215.14", family: 4 }],
};
vi.mock("node:dns", async (importOriginal) => {
  const dns = await importOriginal<typeof import("node:dns")>();
  return {
    ...dns,
    lookup: (host: string, _options: unknown, callback: (error: Error | null, addresses?: unknown) => void) =>
      ANSWERS[host] ? callback(null, ANSWERS[host]) : callback(Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" })),
  };
});
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup: async (host: string) => {
    if (!ANSWERS[host]) {
      throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    }
    return ANSWERS[host];
  },
}));

afterEach(() => vi.unstubAllEnvs());

test.each([
  ["http://example.com/hook", "Webhook URLs must start with https://"],
  ["ftp://example.com", "Webhook URLs must start with https://"],
  ["not a url", "Enter a full URL, like https://example.com/tuti-webhook"],
  ["https://user:pass@example.com/", "Put credentials in your endpoint's checks, not in the URL"],
  ["https://127.0.0.1/", "Webhook URLs must point to a public address"],
  ["https://10.1.2.3/", "Webhook URLs must point to a public address"],
  ["https://172.20.0.1/", "Webhook URLs must point to a public address"],
  ["https://192.168.1.1/", "Webhook URLs must point to a public address"],
  ["https://169.254.169.254/latest/meta-data", "Webhook URLs must point to a public address"],
  ["https://100.64.0.1/", "Webhook URLs must point to a public address"],
  ["https://[::1]/", "Webhook URLs must point to a public address"],
  ["https://[fd00::1]/", "Webhook URLs must point to a public address"],
  ["https://[::ffff:10.0.0.1]/", "Webhook URLs must point to a public address"],
  ["https://[64:ff9b::a00:1]/", "Webhook URLs must point to a public address"],
  ["https://[64:ff9b:1::a00:1]/", "Webhook URLs must point to a public address"],
  ["https://0.0.0.0/", "Webhook URLs must point to a public address"],
  ["https://internal.test/", "Webhook URLs must point to a public address"],
  ["https://mixed.test/", "Webhook URLs must point to a public address"],
  ["https://nowhere.test/", "nowhere.test can't be found"],
])("%s is refused", async (url, message) => {
  await expect(checkWebhookUrl(url)).rejects.toThrow(message);
});

test.each(["https://93.184.215.14/hook", "https://[2606:4700::1111]/hook", "https://public.test/hook"])("%s is fine", async (url) => {
  await expect(checkWebhookUrl(url)).resolves.toBeUndefined();
});

test("self-hosters (and tests) can allow private addresses and http", async () => {
  vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_URLS", "true");
  await expect(checkWebhookUrl("http://127.0.0.1:8080/hook")).resolves.toBeUndefined();
  await expect(checkWebhookUrl("ftp://127.0.0.1/")).rejects.toThrow("https://");
});

test("connections look names up again and refuse private answers (DNS rebinding)", async () => {
  const lookup = (host: string, all: boolean) =>
    new Promise((resolve, reject) =>
      publicOnlyLookup(host, { all }, (error, address, family) => (error ? reject(error) : resolve(all ? address : { address, family }))),
    );
  // The check passed a name, then DNS answers with an internal address for the connection.
  await expect(lookup("internal.test", false)).rejects.toThrow("Webhook URLs must point to a public address");
  await expect(lookup("mixed.test", true)).rejects.toThrow("Webhook URLs must point to a public address");
  await expect(lookup("public.test", false)).resolves.toEqual({ address: "93.184.215.14", family: 4 });
  await expect(lookup("public.test", true)).resolves.toEqual([{ address: "93.184.215.14", family: 4 }]);
  await expect(lookup("nowhere.test", false)).rejects.toThrow("ENOTFOUND");
});
