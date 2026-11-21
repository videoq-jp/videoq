import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./test/workers/worker.ts",
      miniflare: {
        // Intercept below workerd's native fetch, preserving its receiver checks.
        outboundService: async request => {
          const url = new URL(request.url);
          if (url.origin !== "https://materials.example" || request.method !== "POST") {
            return new Response("Unexpected test request", { status: 500 });
          }
          if (url.pathname === "/token-redirect") return Response.redirect("https://materials.example/token", 307);
          if (url.pathname === "/materials-redirect") return Response.redirect("https://materials.example/materials", 307);
          if (url.pathname === "/token") {
            const form = new URLSearchParams(await request.text());
            const assertion = form.get("client_assertion")?.split(".");
            const claims = assertion?.length === 3 ? JSON.parse(Buffer.from(assertion[1], "base64url").toString()) : {};
            const scope = "https://videoq.org/spec/lti-materials/v1";
            if (form.get("grant_type") !== "client_credentials" || form.get("scope") !== scope ||
                form.get("client_assertion_type") !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" ||
                claims.iss !== "worker-client" || claims.sub !== "worker-client" || ![url.href, "https://materials.example/token-redirect"].includes(claims.aud) ||
                claims["https://purl.imsglobal.org/spec/lti/claim/deployment_id"] !== "7") {
              return new Response("Invalid assertion", { status: 401 });
            }
            return Response.json({ access_token: "worker-fixture-token", token_type: "Bearer", expires_in: 60, scope });
          }
          if (url.pathname === "/materials" && request.headers.get("Authorization") === "Bearer worker-fixture-token") {
            const input = await request.json() as { action: string; contextId?: string };
            if (input.action === "courses") return Response.json({ contextIds: ["course-1"] });
            if (input.action === "manifest" && input.contextId === "course-1") {
              return Response.json({ contextId: "course-1", complete: true, resources: [{ externalId: "video-1", manifest: {
                generation: 1, contextId: "course-1", resourceLinkId: "launch-1", enabled: true, title: "Lesson",
                file: { filename: "lesson.mp4", contentType: "video/mp4", size: 3, contentHash: "a".repeat(40) },
              } }] });
            }
          }
          return new Response("Unauthorized test request", { status: 401 });
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["test/workers/**/*.test.ts"],
    // workerd cannot read Vitest's transformed modules from the host filesystem.
    fsModuleCache: false,
  },
});
