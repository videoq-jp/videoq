import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
import { describe, expect, it } from "vitest";

const helm = process.env.HELM_BIN;
const chart = fileURLToPath(new URL("../../../charts/videoq", import.meta.url));
const settings = ["--set", "publicUrl=https://videoq.example.edu", "--set", "storage.endpoint=https://s3.example.edu",
  "--set", "queue.url=http://queue:9324/000000000000/videoq-jobs"];
const withHelm = helm ? describe : describe.skip;

withHelm("on-prem Helm distribution", () => {
  function render(...extra: string[]) {
    const result = spawnSync(helm!, ["template", "test", chart, ...settings, ...extra], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return parseAllDocuments(result.stdout).filter(doc => doc.contents).map(doc => doc.toJSON());
  }
  it("renders only app resources and references operator-managed credentials", () => {
    const resources = render();
    expect(resources.map(resource => resource.kind).sort()).toEqual([
      "ConfigMap", "CronJob", "CronJob", "Deployment", "Deployment", "Deployment", "Job", "Pod", "Service", "Service",
    ].sort());
    const config = resources.find(resource => resource.kind === "ConfigMap");
    expect(config.data).toMatchObject({ DEPLOYMENT_EDITION: "onprem", USE_S3_STORAGE: "true", BETTER_AUTH_URL: "https://videoq.example.edu" });
    expect(Object.values(config.data).every(value => typeof value === "string")).toBe(true);
    expect(config.data.DATABASE_URL).toBeUndefined();
    const api = resources.find(resource => resource.kind === "Deployment" && resource.metadata.name.endsWith("-api"));
    expect(api.spec.template.spec.containers[0].envFrom).toContainEqual({ secretRef: { name: "videoq-runtime" } });
    expect(api.spec.template.spec.containers[0].readinessProbe.httpGet.path).toBe("/ready");
    const migration = resources.find(resource => resource.kind === "Job");
    expect(migration.metadata.annotations["helm.sh/hook"]).toBe("pre-install,pre-upgrade");
    expect(migration.spec.template.spec.containers[0].envFrom).toBeUndefined();
    expect(migration.spec.template.spec.containers[0].env[0].valueFrom.secretKeyRef.key).toBe("DATABASE_URL");
  });
  it("keeps discovery and streaming routes on the API and applies site-specific settings", () => {
    const resources = render("--set", "ingress.enabled=true", "--set", "api.replicas=3", "--set", "worker.replicas=4",
      "--set", "existingSecret=customer-secret", "--set", "imagePullSecrets[0].name=registry-secret",
      "--set", "ai.embeddingModel=gte-qwen2-1.5b-q4km-124fbdad",
      "--set", "ai.embeddingBaseUrl=http://embedding:8000/v1", "--set", "migration.enabled=false");
    expect(resources.some(resource => resource.kind === "Job")).toBe(false);
    const ingress = resources.find(resource => resource.kind === "Ingress");
    expect(ingress.spec.rules[0].host).toBe("videoq.example.edu");
    for (const path of ingress.spec.rules[0].http.paths) {
      expect(path.backend.service.name).toBe(path.path === "/" ? "test-videoq-web" : "test-videoq-api");
    }
    for (const resource of resources.filter(resource => ["Deployment", "CronJob"].includes(resource.kind))) {
      const pod = resource.kind === "Deployment" ? resource.spec.template.spec : resource.spec.jobTemplate.spec.template.spec;
      expect(pod.imagePullSecrets).toEqual([{ name: "registry-secret" }]);
      if (!resource.metadata.name.endsWith("-web")) {
        expect(pod.containers[0].envFrom).toContainEqual({ secretRef: { name: "customer-secret" } });
      }
    }
    expect(resources.find(resource => resource.metadata.name === "test-videoq-api" && resource.kind === "Deployment").spec.replicas).toBe(3);
    expect(resources.find(resource => resource.metadata.name === "test-videoq-worker").spec.replicas).toBe(4);
  });
  it("routes LLM overrides independently of shared OpenRouter services", () => {
    const resources = render("--set", "ai.llmBaseUrl=https://openrouter.ai/api/v1", "--set", "ai.llmModel=vendor/model");
    const config = resources.find(resource => resource.kind === "ConfigMap").data;
    expect(config.LLM_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(config.LLM_MODEL).toBe("vendor/model");
    expect(config.OPENAI_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(config.LLM_API_KEY).toBeUndefined();
    expect(config.OPENROUTER_API_KEY).toBeUndefined();
    expect(config.WHISPER_BACKEND).toBe("openrouter");
    expect(config.EMBEDDING_MODEL).toBe("openai/text-embedding-3-small");
  });
  it("rejects incomplete configuration and invalid proxy/pool settings", () => {
    const missing = spawnSync(helm!, ["template", "test", chart], { encoding: "utf8" });
    expect(missing.status).not.toBe(0);
    for (const setting of ["ai.unknownSetting=true", "api.trustedProxyHops=-1", "api.databasePoolMax=1", "existingSecret=", "publicUrl=https://example.edu/prefix"]) {
      expect(spawnSync(helm!, ["template", "test", chart, ...settings, "--set", setting], { encoding: "utf8" }).status).not.toBe(0);
    }
  });
  it("routes local AI inside the site and restricts application egress", () => {
    const resources = render("-f", `${chart}/examples/local-ai-llamacpp.yaml`);
    const config = resources.find(resource => resource.kind === "ConfigMap").data;
    expect(config.WHISPER_BACKEND).toBe("local");
    expect(config.OPENAI_BASE_URL).toContain(".svc.cluster.local");
    expect(config.LLM_REASONING_EFFORT).toBe("none");
    expect(config.VIDEO_VISUAL_ENABLED).toBe("false");
    const policy = resources.find(resource => resource.kind === "NetworkPolicy");
    expect(policy.spec.policyTypes).toEqual(["Egress"]);
    expect(policy.spec.egress[0].to).toEqual([{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "default" } } }]);
    expect(policy.spec.egress[1].ports.every((port: { port: number }) => port.port === 53)).toBe(true);
  });
  it("selects gpt-oss and the same EmbeddingGemma 2 contract for API and worker", () => {
    const resources = render("-f", `${chart}/examples/local-ai-gpt-oss.yaml`);
    const config = resources.find(resource => resource.kind === "ConfigMap").data;
    expect(config).toMatchObject({
      LLM_MODEL: "videoq-chat", LLM_REASONING_EFFORT: "low", LLM_PRESERVE_TOOL_REASONING: "true",
      LLM_SEPARATE_TOOL_SCHEMA: "true", EMBEDDING_PROFILE: "embeddinggemma2",
      EMBEDDING_MODEL: "embeddinggemma-2-f9972ac", WHISPER_BACKEND: "local", VIDEO_VISUAL_ENABLED: "false",
    });
    expect(config.LLM_BASE_URL).toBe(config.OPENAI_BASE_URL);
    for (const key of ["LLM_BASE_URL", "OPENAI_BASE_URL", "EMBEDDING_BASE_URL", "WHISPER_LOCAL_URL"]) {
      expect(config[key]).toContain(".svc.cluster.local");
    }
    expect(resources.some(resource => resource.kind === "NetworkPolicy")).toBe(true);
  });
  it("routes compatible chat and embedding services independently", () => {
    const resources = render("-f", `${chart}/examples/local-ai-llamacpp.yaml`);
    const config = resources.find(resource => resource.kind === "ConfigMap").data;
    expect(config.OPENAI_BASE_URL).toBe("http://videoq-inference-chat.videoq.svc.cluster.local:8000/v1");
    expect(config.EMBEDDING_BASE_URL).toBe("http://videoq-inference-embedding.videoq.svc.cluster.local:8000/v1");
    expect(config.LLM_SEPARATE_TOOL_SCHEMA).toBe("true");
    expect(config.WHISPER_BACKEND).toBe("local");
  });
  it("allows the public storage origin in the web CSP without exposing the internal endpoint", () => {
    const resources = render("--set", "storage.endpoint=https://s3.example.edu:9443/bucket",
      "--set", "storage.internalEndpoint=http://garage:3900");
    const web = resources.find(resource => resource.kind === "Deployment" && resource.metadata.name.endsWith("-web"));
    expect(web.spec.template.spec.containers[0].env).toContainEqual({
      name: "VIDEOQ_CSP_STORAGE_ORIGINS", value: "https://s3.example.edu:9443",
    });
  });
  it("pins every workload and hook to the reviewed image digests", () => {
    const digest = "sha256:" + "a".repeat(64);
    const resources = render("--set", "requireImageDigests=true",
      ...["api", "web", "worker"].flatMap(component => ["--set", `${component}.image.digest=${digest}`]));
    const images = resources.flatMap(resource => {
      const pod = resource.kind === "Pod" ? resource.spec
        : resource.kind === "CronJob" ? resource.spec.jobTemplate.spec.template.spec
        : ["Deployment", "Job"].includes(resource.kind) ? resource.spec.template.spec : undefined;
      return pod?.containers.map((container: { image: string }) => container.image) ?? [];
    });
    expect(images).toHaveLength(7);
    expect(images.every(image => image.endsWith(`@${digest}`))).toBe(true);
    for (const component of ["api", "web", "worker"]) {
      const flags = ["--set", "requireImageDigests=true",
        ...["api", "web", "worker"].flatMap(name => ["--set", `${name}.image.digest=${name === component ? "" : digest}`])];
      expect(spawnSync(helm!, ["template", "test", chart, ...settings, ...flags], { encoding: "utf8" }).status).not.toBe(0);
    }
    for (const digest of ["sha256:bad", "latest", "sha256:" + "A".repeat(64)]) {
      expect(spawnSync(helm!, ["template", "test", chart, ...settings, "--set", `api.image.digest=${digest}`], { encoding: "utf8" }).status).not.toBe(0);
    }
  });
});
