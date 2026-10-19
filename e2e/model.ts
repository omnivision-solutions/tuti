import { FAKE_MODEL_KEY } from "@tuti/testkit";

/** Scripts the model fake's next reply (AI drafting); the global teardown fails if it isn't used. */
export async function nextModelReply(content: string) {
  const response = await fetch(`${process.env.E2E_MODEL_URL}/_fake/replies`, {
    method: "POST",
    headers: { authorization: `Bearer ${FAKE_MODEL_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    throw new Error(`Couldn't script the model's reply (${response.status})`);
  }
}
