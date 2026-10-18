import { handlers } from "@tuti/jobs";
import { assertEnv, jobs, type JobKey } from "@tuti/shared";
import { getHatchet } from "@tuti/shared/hatchet";

// HATCHET_CLIENT_TOKEN is checked by the Hatchet client itself when tasks are declared.
assertEnv(["DATABASE_URL"]);

const hatchet = getHatchet();
const tasks = (Object.keys(jobs) as JobKey[]).map((key) =>
  hatchet.task({
    name: jobs[key].name,
    inputValidator: jobs[key].input,
    retries: 3,
    fn: (input, ctx) => handlers[key](input as never, ctx.logger),
  }),
);

const worker = await hatchet.worker("tuti-worker", { workflows: tasks, slots: 20 });

await worker.start();
