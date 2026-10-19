import { FAKE_MODEL_KEY, type ModelRequest } from "@tuti/testkit";

/** Every request the app sent the model fake (from all journeys), in order. */
export async function modelRequests(): Promise<ModelRequest[]> {
  const response = await fetch(`${process.env.E2E_MODEL_URL}/_fake/requests`, {
    headers: { authorization: `Bearer ${FAKE_MODEL_KEY}` },
  });
  if (!response.ok) {
    throw new Error(`Couldn't read the model's requests (${response.status})`);
  }
  return (await response.json()) as ModelRequest[];
}

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
