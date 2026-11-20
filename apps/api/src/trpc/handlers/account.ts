import type { Context } from "hono";
import * as userRepository from "../../repositories/user-repository";
import { listConnectedApps, listIntegrationApiKeys } from "../../repositories/account-integrations-repository";
import { accountCredentials } from "../../integrations/account-credentials";
import type { AppEnv } from "../../types/bindings";
import { requireUserId, rpcError, type HandlersFor } from "./shared";

export function accountHandlers(
  c: Context<AppEnv>,
  authenticatedUserId: string | null,
): HandlersFor<"account"> {
  const userId = () => requireUserId(authenticatedUserId);
  const credentials = accountCredentials(c.env, userId);
  return {
    "account.integrationApiKeys": async () => listIntegrationApiKeys(c.env, userId()),
    "account.connectedApps": async () => listConnectedApps(c.env, userId()),
    "account.me": async () => {
      const user = await userRepository.getCurrentUser(c.env, userId());
      if (!user) return rpcError("NOT_FOUND", "User not found");
      return user;
    },
    "account.searchApiKeyStatus": async () => {
      const has = await credentials.status();
      if (has === null) return rpcError("NOT_FOUND", "User not found");
      return { has_api_key: has };
    },
    "account.saveSearchApiKey": async ({ apiKey }) => {
      const ok = await credentials.save(apiKey);
      if (!ok) return rpcError("NOT_FOUND", "User not found");
      return { success: true };
    },
    "account.deleteSearchApiKey": async () => {
      const ok = await credentials.remove();
      if (!ok) return rpcError("NOT_FOUND", "User not found");
      return { success: true };
    },
  };
}
