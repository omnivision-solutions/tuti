import { syncUsers as syncProjectUsers, TooManyProperties, type UserDetails } from "@tuti/jobs";

import { OperationError } from "./operations/define";

export { upsertProjectUser, type UserDetails } from "@tuti/jobs";

/** syncUsers (in @tuti/jobs, so imports in the worker use it too), with `strict`'s refusal as the API's 400. */
export async function syncUsers(projectId: string, users: UserDetails[], options: { strict?: boolean } = {}) {
  try {
    return await syncProjectUsers(projectId, users, options);
  } catch (error) {
    if (error instanceof TooManyProperties) {
      throw new OperationError(400, "invalid_input", error.message);
    }
    throw error;
  }
}
