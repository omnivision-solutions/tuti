import { assertEnv } from "@tuti/shared";
import { getHatchet } from "@tuti/shared/hatchet";

import { postCreated } from "./tasks/post-created";

// HATCHET_CLIENT_TOKEN is checked by the Hatchet client itself when tasks are declared.
assertEnv(["DATABASE_URL"]);

const worker = await getHatchet().worker("tuti-worker", {
  workflows: [postCreated],
  slots: 20,
});

await worker.start();
