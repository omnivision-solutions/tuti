import { FAKE_MODEL_KEY, type FakeDecision, type ModelRequest } from "@tuti/testkit";

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

/**
 * Scripts the model fake's next reply; the global teardown fails if it isn't used. With `match`,
 * only a request whose user message contains it gets the reply (journeys run side by side).
 */
export async function nextModelReply(content: string, match?: string) {
  const response = await fetch(`${process.env.E2E_MODEL_URL}/_fake/replies`, {
    method: "POST",
    headers: { authorization: `Bearer ${FAKE_MODEL_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ content, match }),
  });
  if (!response.ok) {
    throw new Error(`Couldn't script the model's reply (${response.status})`);
  }
}

/**
 * Scripts the decision model's next answers (see the model fake's `decide`); the global teardown
 * fails if they aren't used. With `match`, only a request whose state (as JSON) contains it gets them.
 */
export async function nextDecision(answers: FakeDecision, match?: string) {
  const response = await fetch(`${process.env.E2E_MODEL_URL}/_fake/decisions`, {
    method: "POST",
    headers: { authorization: `Bearer ${FAKE_MODEL_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ answers, match }),
  });
  if (!response.ok) {
    throw new Error(`Couldn't script the decision (${response.status})`);
  }
}
