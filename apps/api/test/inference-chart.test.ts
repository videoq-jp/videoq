import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
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
  it.each(["llamacpp-cpu", "vllm-nvidia"])("provisions independent private model services for %s", (profile) => {
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
      expect(pod.initContainers.find((c: { name: string }) => c.name === "provision-model").command).toEqual(["python", "provision.py"]);
      expect(server.volumeMounts[0].readOnly).toBe(true);
      expect(server.env).toContainEqual({ name: "HF_HUB_OFFLINE", value: "1" });
      expect(server.args.some((arg: string) => arg.startsWith("/models/"))).toBe(true);
      expect(server.args).not.toContain("--trust-remote-code");
      expect(server.resources.limits["nvidia.com/gpu"]).toBe(profile === "vllm-nvidia" ? 1 : undefined);
      if (profile === "llamacpp-cpu") expect(server.args).toContain("--offline");
      else expect(pod.volumes).toContainEqual({ name: "shm", emptyDir: { medium: "Memory", sizeLimit: "2Gi" } });
    }
    const offline = render("-f", `${chart}/examples/${profile}.yaml`, "--set", "downloadModels=false", "--set", "networkPolicy.denyEgress=true");
    for (const deployment of offline.filter(r => r.kind === "Deployment")) {
      const init = deployment.spec.template.spec.initContainers || [];
      expect(init.every((c: { name: string }) => c.name === "provision-audio")).toBe(true);
      for (const container of init) expect(container.args).not.toContain("--download");
    }
    expect(offline.find(r => r.kind === "NetworkPolicy").spec.egress).toEqual([]);
  });
  it("shares one upstream image setting and rejects incompatible architectures", () => {
    expect(command("--set", "servers.embedding.disableTorchCompile=true").status).not.toBe(0);
    const resources = render("-f", `${chart}/examples/gpt-oss-embeddinggemma.yaml`);
    const lock = JSON.parse(resources.find(r => r.kind === "ConfigMap").data["wheels.json"]);
    for (const deployment of resources.filter(r => r.kind === "Deployment")) {
      expect(deployment.spec.template.spec.nodeSelector["kubernetes.io/arch"]).toBe("amd64");
      const engine = deployment.spec.template.spec.containers.find((c: { name: string }) => c.name !== "whisper");
      expect(engine.image).toBe(lock.image);
      expect(engine.env).toContainEqual({ name: "PYTHONPATH", value: "/opt/videoq-audio" });
      if (deployment.metadata.name.endsWith("-embedding")) {
        expect(engine.env).toContainEqual({ name: "TORCHDYNAMO_DISABLE", value: "1" });
        expect(engine.args).toContain("--enforce-eager");
      } else expect(engine.env.some((e: { name: string }) => e.name === "TORCHDYNAMO_DISABLE")).toBe(false);
      expect(engine.volumeMounts).toContainEqual({ name: "vllm-audio", mountPath: "/opt/videoq-audio", readOnly: true });
      expect(deployment.spec.template.spec.initContainers[0].command).toEqual(["python", "provision_audio.py"]);
    }
    for (const key of ["servers.chat", "servers.embedding", "whisper"]) {
      expect(command("-f", `${chart}/examples/gpt-oss-embeddinggemma.yaml`, "--set", `${key}.nodeSelector.kubernetes\\.io/arch=arm64`).status).not.toBe(0);
    }
    expect(command("--set", "whisper.vllmImage.repository=retired").status).not.toBe(0);
    expect(command("-f", `${chart}/examples/gpt-oss-embeddinggemma.yaml`, "--set", `vllm.image.digest=sha256:${"a".repeat(64)}`).status).not.toBe(0);
  });
  it("rejects invalid engines, mutable model revisions, and incompatible weight formats", () => {
    for (const setting of ["backend=unknown", "unknownSetting=true", "servers.chat.unknownSetting=true", "backend=vllm", "servers.chat.modelRevision=main", "servers.chat.modelFile=../model.gguf", "backend=llamacpp,servers.chat.modelSha256="]) {
      expect(command("--set", setting).status).not.toBe(0);
    }
  });
  it("serves all three models from upstream vLLM with independent GPUs and caches", () => {
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
    expect(embed.command).toEqual(["vllm", "serve"]);
    expect(embed.args).toContain("pooling");
    expect(embed.args).toContain("/models/f9972ac22e696a105c482202646979e33e4b5a1e");
    expect(embed.resources.limits["nvidia.com/gpu"]).toBe(1);
    const speech = resources.find(r => r.kind === "Deployment" && r.metadata.name.endsWith("-whisper")).spec.template.spec.containers[1];
    expect(speech.command).toEqual(["vllm", "serve"]);
    expect(server.image).toMatch(/^vllm\/vllm-openai@sha256:/);
    expect(embed.image).toBe(server.image);
    expect(speech.image).toBe(server.image);
    expect(embed.volumeMounts[0].readOnly).toBe(true);
  });
  it("keeps the inference engine on loopback and requires a GPU for the NVIDIA profile", () => {
    const whisper = render().find(r => r.kind === "Deployment" && r.metadata.name.endsWith("-whisper"));
    const engine = whisper.spec.template.spec.containers[1];
    expect(engine.command).toEqual(["/app/build/bin/whisper-server"]);
    expect(engine.image).toMatch(/^ghcr.io\/ggml-org\/whisper.cpp@sha256:/);
    expect(engine.args).toContain("127.0.0.1");
    expect(engine.args).toContain("/v1/audio/transcriptions");
    expect(command("-f", `${chart}/examples/whisper-nvidia.yaml`, "--set-json", 'whisper.resources.limits={"cpu":"2","memory":"4Gi"}').status).not.toBe(0);
  });
  it("selects the native upstream CPU image and rejects architecture mismatches", () => {
    const deployment = render("--set", "whispercpp.architecture=arm64").find(r => r.kind === "Deployment" && r.metadata.name.endsWith("-whisper"));
    expect(deployment.spec.template.spec.nodeSelector["kubernetes.io/arch"]).toBe("arm64");
    expect(deployment.spec.template.spec.containers[1].image).toContain("f0fed3d3d54565cb37d2995fcaa28ca09a5c9f3ffb7fada2d790099af2bfeee0");
    expect(command("--set", "whispercpp.architecture=arm64", "--set-json", 'whisper.nodeSelector={"kubernetes.io/arch":"amd64"}').status).not.toBe(0);
  });
  it("rejects mutable Whisper revisions and unpinned production images", () => {
    for (const setting of ["whisper.modelRevision=main", "whisper.device=auto", "requireImageDigests=true"]) {
      expect(command("--set", setting).status).not.toBe(0);
    }
    const resources = render("--set", "requireImageDigests=true", "--set", `whisper.image.digest=sha256:${"b".repeat(64)}`);
    expect(resources.filter(r => r.kind === "Deployment").every(r => r.spec.template.spec.containers[0].image.includes("@sha256:"))).toBe(true);
  });
  it("runs all three inference engines in separate Pods on explicitly shared NVIDIA slots", () => {
    const documents = render("-f", `${chart}/examples/rtx4090.yaml`);
    const deployments = documents.filter(d => d.kind === "Deployment");
    expect(deployments).toHaveLength(3);
    const plugin = parseAllDocuments(readFileSync(`${chart}/examples/rtx4090-device-plugin.yaml`, "utf8"))[0].toJSON();
    const configuration = parseAllDocuments(plugin.config.map[plugin.config.default])[0].toJSON();
    const sharing = configuration.sharing.timeSlicing;
    expect(sharing.renameByDefault).toBe(true);
    expect(sharing.failRequestsGreaterThanOne).toBe(true);
    expect(sharing.resources).toEqual([{ name: "nvidia.com/gpu", replicas: deployments.length }]);
    const fractions: Record<string, string> = { chat: "0.25", embedding: "0.43", engine: "0.14" };
    for (const deployment of deployments) {
      const pod = deployment.spec.template.spec;
      expect(pod.runtimeClassName).toBe("nvidia");
      expect(pod.nodeSelector).toMatchObject({ "kubernetes.io/arch": "amd64", "videoq.io/inference-target": "rtx4090" });
      const gpuContainers = pod.containers.filter(c => c.resources.limits["nvidia.com/gpu.shared"]);
      expect(gpuContainers).toHaveLength(1);
      const engine = gpuContainers[0];
      expect(engine.resources.requests["nvidia.com/gpu.shared"]).toBe(1);
      expect(engine.resources.limits["nvidia.com/gpu.shared"]).toBe(1);
      expect(engine.resources.limits["nvidia.com/gpu"]).toBeUndefined();
      expect(engine.command).toEqual(["vllm", "serve"]);
      expect(engine.image).toBe(JSON.parse(readFileSync(`${chart}/files/vllm-audio-wheels.json`, "utf8")).image);
      expect(engine.args[engine.args.indexOf("--gpu-memory-utilization") + 1])
        .toBe(fractions[engine.name]);
      expect(engine.args).toContain("--enforce-eager");
      expect(engine.args[engine.args.indexOf("--max-num-seqs") + 1]).toBe("1");
      expect(engine.args[engine.args.indexOf("--cpu-offload-gb") + 1]).toBe("0");
      expect(engine.args).not.toContain("--no-gpu");
      const waits = pod.initContainers.filter(c => c.name.startsWith("wait-for-"));
      expect(waits.map(c => c.name)).toEqual(engine.name === "chat" ? ["wait-for-whisper"] : engine.name === "engine" ? ["wait-for-embedding"] : []);
      for (const container of pod.containers.filter(c => c !== engine)) {
        expect(container.resources.limits["nvidia.com/gpu.shared"]).toBeUndefined();
      }
    }
    const embedding = deployments.find(d => d.metadata.name.endsWith("-embedding"));
    expect(embedding.spec.template.spec.containers[0].args).toContain('{"matryoshka_dimensions":[1536]}');
  });
  it("keeps GPT-OSS, task-aware EmbeddingGemma and Whisper on one shared CUDA GPU", () => {
    const profile = ["-f", `${chart}/examples/rtx4090-gpt-oss-embeddinggemma.yaml`];
    const deployments = render(...profile).filter(d => d.kind === "Deployment");
    for (const deployment of deployments) {
      expect(deployment.spec.template.spec.runtimeClassName).toBe("nvidia");
      const engines = deployment.spec.template.spec.containers.filter(c => c.resources.limits["nvidia.com/gpu.shared"] === 1);
      expect(engines).toHaveLength(1);
    }
    const waits = deployments.flatMap(d => (d.spec.template.spec.initContainers ?? [])
      .filter(c => c.name.startsWith("wait-for-"))
      .map(c => `${d.metadata.name.split("-").at(-1)}:${c.name}`));
    expect(waits.sort()).toEqual(["chat:wait-for-whisper", "whisper:wait-for-embedding"]);
    const embedding = deployments.find(d => d.metadata.name.endsWith("-embedding")).spec.template.spec.containers[0];
    expect(embedding.command).toEqual(["vllm", "serve"]);
    expect(embedding.args).toContain("pooling");
    expect(embedding.args).toContain('{"image":0,"audio":0,"video":0}');
    expect(embedding.args[embedding.args.indexOf("--gpu-memory-utilization") + 1]).toBe("0.07");
    const chat = deployments.find(d => d.metadata.name.endsWith("-chat")).spec.template.spec.containers[0];
    expect(chat.args).toContain("openai_gptoss");
    expect(chat.args[chat.args.indexOf("--dtype") + 1]).toBe("bfloat16");
    const speech = deployments.find(d => d.metadata.name.endsWith("-whisper")).spec.template.spec.containers.find(c => c.name === "engine");
    expect(Number(speech.args[speech.args.indexOf("--max-num-batched-tokens") + 1])).toBeGreaterThanOrEqual(1500);
    expect(embedding.image).toBe(chat.image);
    expect(embedding.image).toBe(speech.image);
    expect(chat.args).toContain("--cpu-offload-gb");
    expect(command(...profile, "--set", "servers.embedding.engine=embeddinggemma2", "--set", "servers.embedding.device=cpu").status).not.toBe(0);
  });
  it("retains startup ordering and private peer connectivity with pre-provisioned offline models", () => {
    const documents = render("-f", `${chart}/examples/rtx4090.yaml`, "--set", "downloadModels=false", "--set", "networkPolicy.denyEgress=true");
    const deployments = documents.filter(d => d.kind === "Deployment");
    expect(deployments.flatMap(d => d.spec.template.spec.initContainers ?? []).map(c => c.name).sort())
      .toEqual(["provision-audio", "provision-audio", "provision-audio", "wait-for-embedding", "wait-for-whisper"]);
    const policy = documents.find(d => d.kind === "NetworkPolicy");
    expect(policy.spec.egress).toHaveLength(2);
    expect(policy.spec.egress[0].to[0].podSelector.matchLabels["app.kubernetes.io/instance"]).toBe("inference");
    expect(policy.spec.egress[1].to[0].namespaceSelector.matchLabels["kubernetes.io/metadata.name"]).toBe("kube-system");
    expect(policy.spec.egress.some(rule => JSON.stringify(rule).includes("ipBlock"))).toBe(false);
  });
  it("rejects shared GPU oversubscription, CPU fallback and bypassed capacity settings", () => {
    const profile = ["-f", `${chart}/examples/rtx4090.yaml`];
    for (const setting of ["gpuSharing.enabled=false", "gpuSharing.memoryFractions.chat=0.6", "gpuSharing.memoryFractions.whisper=0", "whisper.maxSequences=8", "whisper.upstreamParallelism=4", "servers.chat.engine=llamacpp", "whisper.backend=whispercpp", "whisper.resources.limits.nvidia\\.com/gpu=1", "whisper.resources.requests.nvidia\\.com/gpu\\.shared=2"]) {
      expect(command(...profile, "--set", setting).status, setting).not.toBe(0);
    }
    for (const arg of ["--gpu-memory-utilization=0.9", "--gpu_memory_utilization=0.9", "--kv-cache-memory-bytes", "--cpu-offload-gb=4", "--max-num-seqs=64", "--device=cpu"]) {
      expect(command(...profile, "--set-json", `servers.chat.extraArgs=${JSON.stringify([arg])}`).status, arg).not.toBe(0);
    }
    expect(command(...profile, "--set", "gpuSharing.enabled=true", "--set-json", 'servers.chat.resources.limits={"nvidia.com/gpu.shared":1.5}').status).not.toBe(0);
  });
  it("uses signed release locks for every shared GPU engine and refuses missing production pins", () => {
    const profile = ["-f", `${chart}/examples/rtx4090.yaml`, "--set", "requireImageDigests=true"];
    expect(command(...profile).status).not.toBe(0);
    const gateway = `sha256:${"c".repeat(64)}`;
    const engine = JSON.parse(readFileSync(`${chart}/files/vllm-audio-wheels.json`, "utf8")).image.split("@")[1];
    const resources = render(...profile, "--set", `whisper.image.digest=${gateway}`);
    for (const d of resources.filter(d => d.kind === "Deployment")) {
      for (const c of d.spec.template.spec.containers) {
        expect(c.image).toContain(c.name === "whisper" ? gateway : engine);
      }
    }
  });

  it("waits through a real unhealthy HTTP response before releasing shared model startup", async () => {
    const documents = render("-f", `${chart}/examples/rtx4090.yaml`, "--set", "downloadModels=false");
    const whisper = documents.find(d => d.kind === "Deployment" && d.metadata.name.endsWith("-whisper"));
    const wait = whisper.spec.template.spec.initContainers.find(c => c.name === "wait-for-embedding");
    let requests = 0;
    const server = createServer((_request, response) => {
      response.writeHead(++requests === 1 ? 503 : 200);
      response.end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing loopback fixture port");
      const script = wait.args[0].replace(/http:\/\/[^"\s]+/, `http://127.0.0.1:${address.port}/health`);
      const result = await new Promise<{ code: number | null; error: string }>((resolve, reject) => {
        const child = spawn("python3", ["-c", script], { timeout: 8000 });
        let error = "";
        child.stderr.on("data", data => { error += String(data); });
        child.on("error", reject);
        child.on("close", code => resolve({ code, error }));
      });
      expect(result.code, result.error).toBe(0);
      expect(requests).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 10000);

});
