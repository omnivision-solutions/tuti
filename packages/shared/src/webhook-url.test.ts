import { afterEach, expect, test, vi } from "vitest";

import { checkWebhookUrl, publicOnlyLookup } from "./webhook-url";

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
  ["https://localhost/", "Webhook URLs must point to a public address"],
])("%s is refused", async (url, message) => {
  await expect(checkWebhookUrl(url)).rejects.toThrow(message);
});

test.each(["https://93.184.215.14/hook", "https://[2606:4700::1111]/hook"])("%s is fine", async (url) => {
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
  await expect(lookup("localhost", false)).rejects.toThrow("Webhook URLs must point to a public address");
  await expect(lookup("127.0.0.1", true)).rejects.toThrow("Webhook URLs must point to a public address");
  await expect(lookup("93.184.215.14", false)).resolves.toEqual({ address: "93.184.215.14", family: 4 });
  await expect(lookup("93.184.215.14", true)).resolves.toEqual([{ address: "93.184.215.14", family: 4 }]);
});
