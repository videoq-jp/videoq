import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apiRoot = fileURLToPath(new URL("..", import.meta.url));

describe("Cloudflare production configuration", () => {
  it("keeps the invitation limit binding aligned with application code", () => {
    const config = readFileSync(`${apiRoot}/wrangler.jsonc`, "utf8");
    expect(config).toContain('"COURSE_INVITATION_BATCH_LIMIT": "50"');
    expect(config).not.toContain("GROUP_INVITATION_BATCH_LIMIT");
  });

  it("does not configure KV for strongly consistent edge state", () => {
    const config = readFileSync(`${apiRoot}/wrangler.jsonc`, "utf8");
    expect(config).not.toContain("kv_namespaces");
    expect(config).toContain('"name": "RATE_LIMITER"');
  });

  it("uses Mailgun without an unrestricted Email Sending binding", () => {
    const config = readFileSync(`${apiRoot}/wrangler.jsonc`, "utf8");
    expect(config).not.toContain("send_email");
    expect(config).toContain('"MAILGUN_SENDER_DOMAIN": "mg.videoq.jp"');
  });

  it("enables complete logs and sampled production traces", () => {
    const config = readFileSync(`${apiRoot}/wrangler.jsonc`, "utf8");
    expect(config).toContain('"logs": { "enabled": true, "head_sampling_rate": 1 }');
    expect(config).toContain(
      '"traces": { "enabled": true, "head_sampling_rate": 0.05 }',
    );
  });

  it("allows only the browser media operations required by VideoQ", () => {
    const policy = JSON.parse(
      readFileSync(`${apiRoot}/r2-cors.production.json`, "utf8"),
    ) as {
      rules: Array<{
        allowed: { origins: string[]; methods: string[]; headers: string[] };
        exposeHeaders: string[];
        maxAgeSeconds: number;
      }>;
    };

    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0]).toEqual(
      expect.objectContaining({
        allowed: {
          origins: ["https://videoq.jp"],
          methods: ["GET", "HEAD", "PUT"],
          headers: ["Content-Type", "Range"],
        },
        exposeHeaders: [
          "Accept-Ranges",
          "Content-Length",
          "Content-Range",
          "ETag",
        ],
        maxAgeSeconds: 3600,
      }),
    );
  });
});
