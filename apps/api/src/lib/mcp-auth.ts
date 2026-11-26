import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from "../domain/lms/resource-access";
export { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from "../domain/lms/resource-access";
export const MCP_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  MCP_READ_SCOPE,
  MCP_WRITE_SCOPE,
] as const;
