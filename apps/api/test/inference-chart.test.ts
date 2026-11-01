import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { parse, parseAllDocuments } from "yaml";
import { describe, expect, it } from "vitest";

const helm = process.env.HELM_BIN;
const chart = fileURLToPath(new URL("../../../charts/videoq-inference", import.meta.url));
const withHelm = helm ? describe : describe.skip;

withHelm("private local inference deployment", () => {
  const command = (...extra: string[]) => spawnSync(helm!, ["template", "inference", chart, ...extra], { encoding: "utf8" });
  function render(...extra: string[]) {
    const result = command(...extra);
    expect(result.status, result.stderr).toBe(0);
    return parseAllDocuments(result.stdout).filter(doc => doc.contents).map(doc => doc.toJSON());
  }
  it("keeps models persistent and serves only private APIs with cloud inference disabled", () => {
    const resources = render();
    expect(resources.filter(r => r.kind === "Service")).toHaveLength(3);
    expect(resources.filter(r => r.kind === "Service").every(r => r.spec.type === "ClusterIP")).toBe(true);
    expect(resources.filter(r => r.kind === "PersistentVolumeClaim")).toHaveLength(3);
    const pods = resources.filter(r => r.kind === "Deployment").map(r => r.spec.template.spec);
    for (const pod of pods) {
      expect(pod.automountServiceAccountToken).toBe(false);
      expect(pod.initContainers).toHaveLength(1);
      expect(pod.securityContext.runAsNonRoot).toBe(true);
    }
    for (const pod of pods) {
      const server = pod.containers[0];
      expect(server.resources.limits["nvidia.com/gpu"]).toBeUndefined();
      expect(server.env).toContainEqual({ name: "HF_HUB_OFFLINE", value: "1" });
    }
    expect(resources.find(r => r.metadata.name === "videoq-inference-chat" && r.kind === "Deployment")
      .spec.template.spec.containers[0].args).toContain("--offline");
    const whisper = pods.find(p => p.containers[0].name === "whisper");
    expect(whisper.containers[0].env).toContainEqual({ name: "HF_HUB_OFFLINE", value: "1" });
    expect(whisper.containers[0].env).toContainEqual({ name: "WHISPER_UPSTREAM_PARALLELISM", value: "1" });
    expect(whisper.containers[0].env).toContainEqual({ name: "WHISPER_REQUEST_TIMEOUT_SECONDS", value: "600" });
    expect(whisper.containers[1].resources.requests.cpu).toBe("2");
    expect(whisper.containers[0].volumeMounts[0].readOnly).toBe(true);
    const policy = resources.find(r => r.kind === "NetworkPolicy");
    expect(policy.spec.ingress[0].ports.map((port: { port: number }) => port.port).sort()).toEqual([8000, 8080]);
    expect(policy.spec.ingress[0].from[0]).toMatchObject({
      namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "videoq" } },
      podSelector: { matchLabels: { "app.kubernetes.io/instance": "videoq" } },
    });
  });
  it("can remove every model downloader and deny inference egress after provisioning", () => {
    const resources = render("--set", "downloadModels=false", "--set", "networkPolicy.denyEgress=true");
    for (const deployment of resources.filter(r => r.kind === "Deployment")) {
      expect(deployment.spec.template.spec.initContainers).toBeUndefined();
    }
    expect(resources.find(r => r.kind === "NetworkPolicy").spec.egress).toEqual([]);
    expect(command("--set", "networkPolicy.denyEgress=true").status).not.toBe(0);
  });
  it("requests NVIDIA GPUs only when explicitly enabled", () => {
    const resources = render("-f", `${chart}/examples/whisper-nvidia.yaml`);
    for (const deployment of resources.filter(r => r.kind === "Deployment")) {
      const container = deployment.spec.template.spec.containers[0];
      const whisper = deployment.metadata.name.endsWith("-whisper");
      expect(container.resources.limits["nvidia.com/gpu"]).toBeUndefined();
      if (whisper) expect(deployment.spec.template.spec.containers[1].resources.limits["nvidia.com/gpu"]).toBe(1);
      if (whisper) {
        expect(deployment.spec.template.spec.nodeSelector["kubernetes.io/arch"]).toBe("amd64");
        expect(container.env).toContainEqual({ name: "WHISPER_UPSTREAM_PARALLELISM", value: "4" });
        expect(container.env).toContainEqual({ name: "WHISPER_REQUEST_TIMEOUT_SECONDS", value: "110" });
        const engine = deployment.spec.template.spec.containers[1];
        expect(engine.command).toEqual(["vllm", "serve"]);
        expect(engine.args).toContain("127.0.0.1");
        expect(engine.args).toContain("--max-num-seqs");
      }
    }
  });
  it("bounds speech concurrency and rejects retired or invalid settings", () => {
    const whisper = render("--set", "whisper.upstreamParallelism=4")
      .find(r => r.kind === "Deployment" && r.metadata.name.endsWith("-whisper"));
    expect(whisper.spec.template.spec.containers[0].env)
      .toContainEqual({ name: "WHISPER_UPSTREAM_PARALLELISM", value: "4" });
    for (const setting of ["whisper.upstreamParallelism=0", "whisper.upstreamParallelism=9", "whisper.maxConcurrentRequests=5", "whisper.requestTimeoutSeconds=0", "whisper.requestTimeoutSeconds=601", "whisper.batchSize=8", "whisper.backend=faster-whisper"]) {
      expect(command("--set", setting).status).not.toBe(0);
    }
  });
  it.each(["llamacpp-cpu", "vllm-nvidia", "vllm-amd"])("provisions independent private model services for %s", (profile) => {
    const resources = render("-f", `${chart}/examples/${profile}.yaml`);
    expect(resources.filter(r => r.kind === "Service").map(r => r.metadata.name).sort()).toEqual([
      "videoq-inference-chat", "videoq-inference-embedding", "videoq-inference-whisper",
    ]);
    expect(resources.filter(r => r.kind === "PersistentVolumeClaim")).toHaveLength(3);
    for (const resource of resources.filter(r => r.kind === "Deployment" && !r.metadata.name.endsWith("-whisper"))) {
      const pod = resource.spec.template.spec;
      const server = pod.containers[0];
      expect(pod.automountServiceAccountToken).toBe(false);
      expect(pod.securityContext.runAsNonRoot).toBe(true);
      expect(pod.initContainers[0].command).toEqual(["python", "provision.py"]);
      expect(server.volumeMounts[0].readOnly).toBe(true);
      expect(server.env).toContainEqual({ name: "HF_HUB_OFFLINE", value: "1" });
      expect(server.args.some((arg: string) => arg.startsWith("/models/"))).toBe(true);
      expect(server.args).not.toContain("--trust-remote-code");
      expect(server.resources.limits["nvidia.com/gpu"]).toBe(profile === "vllm-nvidia" ? 1 : undefined);
      expect(server.resources.limits["amd.com/gpu"]).toBe(profile === "vllm-amd" ? 1 : undefined);
      if (profile === "llamacpp-cpu") expect(server.args).toContain("--offline");
      else expect(pod.volumes).toContainEqual({ name: "shm", emptyDir: { medium: "Memory", sizeLimit: "2Gi" } });
    }
    const offline = render("-f", `${chart}/examples/${profile}.yaml`, "--set", "downloadModels=false", "--set", "networkPolicy.denyEgress=true");
    for (const deployment of offline.filter(r => r.kind === "Deployment")) {
      const names = deployment.spec.template.spec.initContainers?.map((c: {name: string}) => c.name) ?? [];
      expect(names).not.toContain("provision-model");
      expect(names).toEqual(profile === "vllm-amd" && deployment.metadata.name.endsWith("-whisper") ? ["provision-audio"] : []);
    }
    expect(offline.find(r => r.kind === "NetworkPolicy").spec.egress).toEqual([]);
  });
  it("rejects invalid engines, mutable model revisions, and incompatible weight formats", () => {
    for (const setting of ["backend=unknown", "unknownSetting=true", "servers.chat.unknownSetting=true", "backend=vllm", "servers.chat.modelRevision=main", "servers.chat.modelFile=../model.gguf", "backend=llamacpp,servers.chat.modelSha256="]) {
      expect(command("--set", setting).status).not.toBe(0);
    }
  });
  it("serves gpt-oss on one GPU and text-only EmbeddingGemma 2 on CPU with independent caches", () => {
    const resources = render("-f", `${chart}/examples/gpt-oss-embeddinggemma.yaml`);
    const chat = resources.find(r => r.kind === "Deployment" && r.metadata.name.endsWith("-chat"));
    const embedding = resources.find(r => r.kind === "Deployment" && r.metadata.name.endsWith("-embedding"));
    const server = chat.spec.template.spec.containers[0];
    expect(server.args).toContain("openai");
    expect(server.args).toContain("--reasoning-parser");
    expect(server.args[server.args.indexOf("--reasoning-parser") + 1]).toBe("openai_gptoss");
    expect(server.args).not.toContain("--default-chat-template-kwargs");
    expect(server.resources.limits["nvidia.com/gpu"]).toBe(1);
    const embed = embedding.spec.template.spec.containers[0];
    expect(embed.command).toEqual(["python", "-m", "uvicorn", "embedding_server:app"]);
    expect(embed.env).toContainEqual({ name: "EMBEDDING_MODEL_ALIAS", value: "embeddinggemma-2-f9972ac" });
    expect(embed.env).toContainEqual({ name: "EMBEDDING_MODEL_PATH", value: "/models/f9972ac22e696a105c482202646979e33e4b5a1e" });
    expect(embed.resources.limits["nvidia.com/gpu"]).toBeUndefined();
    expect(embed.volumeMounts[0].readOnly).toBe(true);
  });
  it("rejects conflicting per-role engine aliases and keeps AMD chat independent of CPU embeddings", () => {
    expect(command("-f", `${chart}/examples/gpt-oss-embeddinggemma.yaml`, "--set", "servers.embedding.backend=llamacpp").status).not.toBe(0);
    const resources = render("-f", `${chart}/examples/gpt-oss-embeddinggemma.yaml`, "--set", "servers.chat.accelerator=amd", "--set-json", 'servers.chat.resources={"requests":{"amd.com/gpu":1},"limits":{"amd.com/gpu":1}}');
    const chat = resources.find(r => r.kind === "Deployment" && r.metadata.name.endsWith("-chat")).spec.template.spec.containers[0];
    const embedding = resources.find(r => r.kind === "Deployment" && r.metadata.name.endsWith("-embedding")).spec.template.spec.containers[0];
    expect(chat.image).toMatch(/^vllm\/vllm-openai-rocm@sha256:/);
    expect(embedding.command).toContain("embedding_server:app");
    expect(embedding.resources.limits["amd.com/gpu"]).toBeUndefined();
  });
  it("keeps the inference engine on loopback and requires a GPU for the NVIDIA profile", () => {
    const whisper = render().find(r => r.kind === "Deployment" && r.metadata.name.endsWith("-whisper"));
    const engine = whisper.spec.template.spec.containers[1];
    expect(engine.command).toEqual(["/app/build/bin/whisper-server"]);
    expect(engine.image).toMatch(/^ghcr.io\/ggml-org\/whisper.cpp@sha256:/);
    expect(engine.image).not.toBe(whisper.spec.template.spec.containers[0].image);
    expect(engine.args).toContain("127.0.0.1");
    expect(engine.args).toContain("/v1/audio/transcriptions");
    expect(command("-f", `${chart}/examples/whisper-nvidia.yaml`, "--set-json", 'whisper.resources.limits={"cpu":"2","memory":"4Gi"}').status).not.toBe(0);
  });
  it("selects the upstream CPU image and matching node architecture", () => {
    const resources = render("--set", "whispercpp.architecture=arm64");
    const pod = resources.find(r => r.kind === "Deployment" && r.metadata.name.endsWith("-whisper")).spec.template.spec;
    expect(pod.nodeSelector["kubernetes.io/arch"]).toBe("arm64");
    expect(pod.containers[1].image).toBe("ghcr.io/ggml-org/whisper.cpp@sha256:f0fed3d3d54565cb37d2995fcaa28ca09a5c9f3ffb7fada2d790099af2bfeee0");
    expect(command("--set", "whispercpp.architecture=arm64", "--set", "whisper.nodeSelector.kubernetes\\.io/arch=amd64").status).not.toBe(0);
  });
  it("uses the same pinned upstream vLLM image for chat, embeddings and speech", () => {
    const resources = render("-f", `${chart}/examples/vllm-nvidia.yaml`, "-f", `${chart}/examples/whisper-nvidia.yaml`);
    const deployments = resources.filter(r => r.kind === "Deployment");
    const images = deployments.map(r => r.spec.template.spec.containers.find((c: {name: string}) => c.name !== "whisper").image);
    expect(new Set(images).size).toBe(1);
    expect(images[0]).toBe("vllm/vllm-openai@sha256:befccf0e7e4089aa23926bb6f887a85c0d46c2a99e6de5c5ffdf5cb7957c5b34");
  });
  it("selects upstream ROCm and AMD devices for all three model roles", () => {
    const resources = render("-f", `${chart}/examples/vllm-amd.yaml`, "--set-json", "vllm.supplementalGroups=[44,109]");
    for (const deployment of resources.filter(r => r.kind === "Deployment")) {
      const pod = deployment.spec.template.spec;
      const engine = pod.containers.at(-1);
      expect(engine.image).toMatch(/^vllm\/vllm-openai-rocm@sha256:/);
      expect(engine.resources.requests["amd.com/gpu"]).toBe(1);
      expect(engine.resources.limits["amd.com/gpu"]).toBe(1);
      expect(engine.resources.limits["nvidia.com/gpu"]).toBeUndefined();
      expect(pod.nodeSelector["kubernetes.io/os"]).toBe("linux");
      expect(pod.securityContext.supplementalGroups).toEqual([44,109]);
      expect(pod.securityContext.runAsNonRoot).toBe(true);
      expect(engine.securityContext.capabilities.drop).toEqual(["ALL"]);
      expect(engine.securityContext.privileged).toBeUndefined();
      expect(engine.volumeMounts.find((m: {name: string}) => m.name === "models").readOnly).toBe(true);
      if (deployment.metadata.name.endsWith("-whisper")) {
        expect(engine.env).toContainEqual({ name: "PYTHONPATH", value: "/audio-deps" });
        expect(engine.volumeMounts).toContainEqual({ name: "audio-deps", mountPath: "/audio-deps", readOnly: true });
        const codec = pod.initContainers.find((c: {name: string}) => c.name === "provision-audio");
        expect(codec.command).toEqual(["python", "provision_audio.py"]);
        expect(codec.volumeMounts).toEqual([{ name: "audio-deps", mountPath: "/audio-deps" }]);
      }
    }
  });
  it("can use AMD speech with CPU chat and embeddings", () => {
    const resources = render("-f", `${chart}/examples/whisper-amd.yaml`);
    for (const deployment of resources.filter(r => r.kind === "Deployment")) {
      const pod = deployment.spec.template.spec;
      const engine = pod.containers.at(-1);
      if (deployment.metadata.name.endsWith("-whisper")) {
        expect(engine.image).toMatch(/^vllm\/vllm-openai-rocm@sha256:/);
        expect(engine.resources.limits["amd.com/gpu"]).toBe(1);
        expect(pod.containers[0].resources.limits["amd.com/gpu"]).toBeUndefined();
      } else {
        expect(engine.image).toMatch(/^ghcr.io\/ggml-org\/llama.cpp@sha256:/);
        expect(engine.resources.limits["amd.com/gpu"]).toBeUndefined();
      }
    }
  });
  it("rejects mismatched GPU vendors, counts and unpinned ROCm images", () => {
    for (const setting of [
      "vllm.accelerator=unknown", "vllm.accelerator=nvidia",
      "whisper.resources.limits.amd\\.com/gpu=2",
      "servers.chat.resources.requests.amd\\.com/gpu=0",
      "servers.embedding.resources.requests.amd\\.com/gpu=2",
      "servers.chat.resources.limits.nvidia\\.com/gpu=1",
      "whisper.resources.requests.nvidia\\.com/gpu=1",
      "whisper.backend=whispercpp", "backend=llamacpp",
    ]) {
      expect(command("-f", `${chart}/examples/vllm-amd.yaml`, "--set", setting).status, setting).not.toBe(0);
    }
    expect(command("--set", "whisper.resources.limits.amd\\.com/gpu=1").status).not.toBe(0);
    expect(command("-f", `${chart}/examples/vllm-amd.yaml`, "--set", "requireImageDigests=true", "--set", `whisper.image.digest=sha256:${"b".repeat(64)}`, "--set", "vllm.rocmImage.digest=").status).not.toBe(0);
  });
  it("rejects mutable Whisper revisions and unpinned production images", () => {
    for (const setting of ["whisper.modelRevision=main", "whisper.device=auto", "requireImageDigests=true"]) {
      expect(command("--set", setting).status).not.toBe(0);
    }
    const resources = render("--set", "requireImageDigests=true", "--set", `whisper.image.digest=sha256:${"b".repeat(64)}`);
    expect(resources.filter(r => r.kind === "Deployment").every(r => r.spec.template.spec.containers[0].image.includes("@sha256:"))).toBe(true);
  });
  const choices = ["external", "cpu", "nvidia", "amd"] as const;
  const combinations = choices.flatMap(chat => choices.flatMap(embedding => choices.map(speech => ({ chat, embedding, speech }))));
  it.each(combinations)("keeps role selection independent: $chat / $embedding / $speech", ({ chat, embedding, speech }) => {
    const nvidia = parse(readFileSync(`${chart}/examples/vllm-nvidia.yaml`, "utf8"));
    const amd = parse(readFileSync(`${chart}/examples/vllm-amd.yaml`, "utf8"));
    function settings(mode: typeof choices[number], role: "chat" | "embedding" | "speech") {
      if (mode === "external") return { enabled: false };
      if (mode === "cpu") return { enabled: true, backend: role === "speech" ? "whispercpp" : "llamacpp" };
      const profile = mode === "amd" ? amd : nvidia;
      return { ...(role === "speech" ? profile.whisper : profile.servers[role]), enabled: true, backend: "vllm", accelerator: mode };
    }
    const values = {
      downloadModels: false,
      vllm: { accelerator: speech === "nvidia" ? "amd" : "nvidia" },
      servers: { chat: settings(chat, "chat"), embedding: settings(embedding, "embedding") },
      whisper: settings(speech, "speech"),
    };
    const args = Object.entries(values).flatMap(([key, value]) => ["--set-json", `${key}=${JSON.stringify(value)}`]);
    const resources = render(...args);
    for (const [role, mode] of [["chat", chat], ["embedding", embedding], ["whisper", speech]]) {
      const deployment = resources.find(r => r.kind === "Deployment" && r.metadata.name === `videoq-inference-${role}`);
      const service = resources.find(r => r.kind === "Service" && r.metadata.name === `videoq-inference-${role}`);
      const claim = resources.find(r => r.kind === "PersistentVolumeClaim" && r.metadata.name === `videoq-inference-${role}`);
      if (mode === "external") {
        expect(deployment).toBeUndefined();
        expect(service).toBeUndefined();
        expect(claim).toBeUndefined();
        continue;
      }
      expect(service).toBeDefined();
      expect(claim).toBeDefined();
      const pod = deployment.spec.template.spec;
      const engine = pod.containers.at(-1);
      const prefix = mode === "cpu" ? (role === "whisper" ? "ghcr.io/ggml-org/whisper.cpp" : "ghcr.io/ggml-org/llama.cpp")
        : mode === "amd" ? "vllm/vllm-openai-rocm" : "vllm/vllm-openai";
      expect(engine.image.startsWith(`${prefix}@sha256:`)).toBe(true);
      expect(engine.resources.limits["amd.com/gpu"]).toBe(mode === "amd" ? 1 : undefined);
      expect(engine.resources.limits["nvidia.com/gpu"]).toBe(mode === "nvidia" ? 1 : undefined);
      expect(pod.initContainers?.map((c: {name: string}) => c.name) ?? []).toEqual(role === "whisper" && mode === "amd" ? ["provision-audio"] : []);
    }
  });
  it("does not deploy models or reserve caches for disabled roles", () => {
    const resources = render("--set", "backend=vllm", "--set", "servers.chat.enabled=false,servers.embedding.enabled=false");
    for (const kind of ["Deployment", "Service", "PersistentVolumeClaim"]) {
      expect(resources.filter(r => r.kind === kind).map(r => r.metadata.name)).toEqual(["videoq-inference-whisper"]);
    }
    expect(resources.find(r => r.kind === "NetworkPolicy").spec.ingress[0].ports).toEqual([{ protocol: "TCP", port: 8080 }]);
    expect(render("--set", "whisper.enabled=false,servers.chat.enabled=false,servers.embedding.enabled=false,requireImageDigests=true,networkPolicy.denyEgress=true")).toEqual([]);
  });
  it("can use existing speech while retaining only local chat and embedding resources", () => {
    const resources = render("--set", "whisper.enabled=false,whisper.backend=vllm");
    expect(resources.filter(r => r.kind === "Deployment").map(r => r.metadata.name).sort()).toEqual([
      "videoq-inference-chat", "videoq-inference-embedding",
    ]);
    expect(resources.filter(r => r.kind === "PersistentVolumeClaim")).toHaveLength(2);
    expect(resources.find(r => r.kind === "NetworkPolicy").spec.ingress[0].ports).toEqual([{ protocol: "TCP", port: 8000 }]);
  });
  it("selects a backend and GPU vendor independently for each model role", () => {
    const resources = render("-f", `${chart}/examples/mixed-engines.yaml`, "--set-json", 'whisper.extraArgs=["--enforce-eager"]');
    const pods = Object.fromEntries(resources.filter(r => r.kind === "Deployment").map(r => [r.metadata.name, r.spec.template.spec]));
    const chat = pods["videoq-inference-chat"].containers[0];
    const embedding = pods["videoq-inference-embedding"].containers[0];
    const speech = pods["videoq-inference-whisper"].containers.at(-1);
    expect(chat.image).toMatch(/^vllm\/vllm-openai@sha256:/);
    expect(chat.resources.limits["nvidia.com/gpu"]).toBe(1);
    expect(embedding.image).toMatch(/^ghcr.io\/ggml-org\/llama.cpp@sha256:/);
    expect(embedding.args).toContain("--embedding");
    expect(embedding.resources.limits["amd.com/gpu"]).toBeUndefined();
    expect(speech.image).toMatch(/^vllm\/vllm-openai-rocm@sha256:/);
    expect(speech.resources.limits["amd.com/gpu"]).toBe(1);
    expect(speech.args).toContain("--enforce-eager");
  });
  it("can retire bundled codecs when an upstream image supplies them", () => {
    const resources = render("-f", `${chart}/examples/vllm-amd.yaml`, "--set", "whisper.audioCodecs=upstream,downloadModels=false");
    const pod = resources.find(r => r.kind === "Deployment" && r.metadata.name.endsWith("-whisper")).spec.template.spec;
    expect(pod.initContainers).toBeUndefined();
    expect(pod.volumes.some((v: {name: string}) => v.name === "audio-deps")).toBe(false);
    expect(pod.containers.at(-1).env.some((e: {name: string}) => e.name === "PYTHONPATH")).toBe(false);
    expect(command("--set", "whisper.audioCodecs=unknown").status).not.toBe(0);
  });
  it("places all CPU workloads on arm64 Linux when selected", () => {
    const resources = render("-f", `${chart}/examples/cpu-arm64.yaml`);
    for (const deployment of resources.filter(r => r.kind === "Deployment")) {
      expect(deployment.spec.template.spec.nodeSelector).toEqual({ "kubernetes.io/arch": "arm64", "kubernetes.io/os": "linux" });
    }
    expect(resources.find(r => r.kind === "Deployment" && r.metadata.name.endsWith("-whisper"))
      .spec.template.spec.containers.at(-1).image).toBe("ghcr.io/ggml-org/whisper.cpp@sha256:f0fed3d3d54565cb37d2995fcaa28ca09a5c9f3ffb7fada2d790099af2bfeee0");
  });
});
