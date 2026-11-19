-- drizzle-kit:custom
-- MCP initialization/discovery are authenticated requests, not AI/tool executions.
UPDATE apikey SET rate_limit_max = 1200, rate_limit_time_window = 3600000,
  request_count = 0, last_request = NULL
WHERE config_id IN ('default', 'read-write')
  AND enabled = true
  AND rate_limit_enabled = true
  AND rate_limit_max = 10 AND rate_limit_time_window = 86400000;
