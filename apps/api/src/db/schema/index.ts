export * from './agent-skills';
import * as agentSkills from './agent-skills';
/** Runtime Drizzle schema. */
export * from "./modern";
export * from "./better-auth";
export * from "./lms";

import * as modern from "./modern";
import * as betterAuth from "./better-auth";
import * as lms from "./lms";

/** drizzle(client, { schema }) uses only application-owned tables. */
export const schema = { ...agentSkills, ...modern, ...betterAuth, ...lms };
