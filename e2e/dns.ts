/** Publishes a TXT record in the DNS fake the app looks records up in (see global-setup.ts). */
export async function publishTxt(name: string, value: string) {
  const response = await fetch(`${process.env.E2E_DNS_URL}/_fake/txt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, values: [value] }),
  });
  if (!response.ok) {
    throw new Error(`Couldn't publish the TXT record ${name} (${response.status})`);
  }
}
