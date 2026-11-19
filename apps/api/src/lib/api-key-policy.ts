/** Includes MCP initialization, notifications and tool discovery; tool quotas remain per user. */
export const API_KEY_RATE_LIMIT = { enabled: true, timeWindow: 60 * 60 * 1000, maxRequests: 1200 } as const;
