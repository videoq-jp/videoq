"""Read-only RTX 4090 host and allocated-Pod checks; never installs or labels nodes.

Host checks do not prove model acceptance. --node additionally checks one Ready
Pod per role, shared allocations and an actual CUDA operation in each engine.
The full VideoQ processing/learning journey is a separate acceptance gate.
"""
import argparse
import csv
import io
import json
import os
import platform
import re
import subprocess


ROLES = {"chat": "chat", "embedding": "embedding", "whisper": "engine"}


def run(*args):
    return subprocess.check_output(args, text=True, timeout=60).strip()


def validate_host(system, machine, os_release, gpu_csv):
    if system != "Linux" or machine != "x86_64":
        raise ValueError("The target is native Linux amd64, not emulation, ARM64 or Windows")
    if os_release.get("ID") != "ubuntu" or os_release.get("VERSION_ID") != "24.04":
        raise ValueError("The target OS is Ubuntu 24.04 LTS")
    gpus = list(csv.reader(io.StringIO(gpu_csv)))
    if len(gpus) != 1 or len(gpus[0]) != 3:
        raise ValueError("Exactly one physical GPU is required for this profile")
    name, uuid, memory = [x.strip() for x in gpus[0]]
    if name not in ("NVIDIA GeForce RTX 4090", "NVIDIA RTX 4090"):
        raise ValueError("The physical GPU must be an RTX 4090")
    if not re.fullmatch(r"GPU-[a-fA-F0-9-]+", uuid) or float(memory) < 23000:
        raise ValueError("Expected a GPU UUID and approximately 24 GiB of physical VRAM")
    return {"name": name, "uuid": uuid, "memory_mib": float(memory)}


def validate_node(node):
    labels = node["metadata"].get("labels", {})
    if any(labels.get(k) != v for k, v in {
        "kubernetes.io/arch": "amd64", "kubernetes.io/os": "linux",
        "videoq.io/inference-target": "rtx4090",
    }.items()):
        raise ValueError("Node architecture/OS/explicit RTX 4090 opt-in labels differ")
    resources = node["status"].get("allocatable", {})
    if resources.get("nvidia.com/gpu.shared") != "3" or resources.get("nvidia.com/gpu", "0") != "0":
        raise ValueError("The device plugin must advertise exactly three shared slots and no exclusive slots")
    if not any(c["type"] == "Ready" and c["status"] == "True" for c in node["status"].get("conditions", [])):
        raise ValueError("Node is not Ready")


def validate_pods(pods, node):
    found = {}
    for pod in pods:
        if pod["metadata"].get("deletionTimestamp"):
            raise ValueError("Wait for old inference Pods to terminate")
        role = pod["metadata"].get("labels", {}).get("app.kubernetes.io/component")
        if role not in ROLES or role in found:
            raise ValueError("Expected exactly one inference Pod for each role")
        spec = pod["spec"]
        if spec.get("nodeName") != node or spec.get("runtimeClassName") != "nvidia":
            raise ValueError("All inference Pods must use the NVIDIA runtime on the selected workstation")
        containers = {c["name"]: c for c in spec["containers"]}
        engine = containers[ROLES[role]]
        for kind in ["requests", "limits"]:
            resource = engine["resources"][kind]
            if resource.get("nvidia.com/gpu.shared") not in (1, "1") or "nvidia.com/gpu" in resource:
                raise ValueError("Each engine must request exactly one shared slot")
        if not re.search(r"@sha256:[a-f0-9]{64}$", engine["image"]):
            raise ValueError("Use the verified immutable release lock before runtime acceptance")
        if not all(s.get("ready") for s in pod.get("status", {}).get("containerStatuses", [])) or len(pod.get("status", {}).get("containerStatuses", [])) != len(containers):
            raise ValueError("Wait for every container to become Ready")
        for name, container in containers.items():
            if name != ROLES[role] and any(k.startswith("nvidia.com/") for k in container.get("resources", {}).get("limits", {})):
                raise ValueError("Only the inference engine should reserve GPU access")
        found[role] = pod["metadata"]["name"]
    if set(found) != set(ROLES):
        raise ValueError("Expected three independent Ready inference Pods")
    return found


CUDA_CHECK = '''import json, subprocess, torch, urllib.request
assert torch.version.cuda and not torch.version.hip, "CUDA PyTorch required"
assert torch.cuda.is_available() and torch.cuda.device_count() == 1, "One allocated CUDA device required"
assert torch.cuda.get_device_capability(0) == (8, 9), "RTX 4090 compute capability required"
a = torch.ones((32, 32), dtype=torch.float16, device="cuda")
assert bool(((a @ a) == 32).all().item()), "FP16 CUDA operation failed"
with urllib.request.build_opener(urllib.request.ProxyHandler({})).open("http://127.0.0.1:PORT/health", timeout=10) as r:
    assert r.status == 200
print(json.dumps({"gpu_uuid": subprocess.check_output(["nvidia-smi", "--query-gpu=uuid", "--format=csv,noheader"], text=True).strip(), "device": torch.cuda.get_device_name(0), "cuda": torch.version.cuda, "fp16_matmul": "passed", "engine_health": "passed"}))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", help="Also inspect this local workstation's Kubernetes node and inference Pods")
    parser.add_argument("--namespace", default="videoq")
    parser.add_argument("--release", default="inference")
    args = parser.parse_args()
    # platform.freedesktop_os_release handles quoted os-release values.
    gpu = validate_host(platform.system(), platform.machine(), platform.freedesktop_os_release(),
                        run("nvidia-smi", "--query-gpu=name,uuid,memory.total", "--format=csv,noheader,nounits"))
    result = {"host": gpu, "logical_cpus": os.cpu_count(), "driver": run("nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"),
              "allocated_cuda_checks": "not run", "full_videoq_acceptance": "not established"}
    if args.node:
        validate_node(json.loads(run("kubectl", "get", "node", args.node, "-o", "json")))
        selector = "app.kubernetes.io/name=videoq-inference,app.kubernetes.io/instance=" + args.release
        pods = json.loads(run("kubectl", "-n", args.namespace, "get", "pods", "-l", selector, "-o", "json"))["items"]
        found = validate_pods(pods, args.node)
        result["allocated_cuda_checks"] = {}
        for role, pod in found.items():
            port = "8081" if role == "whisper" else "8000"
            evidence = json.loads(run("kubectl", "-n", args.namespace, "exec", pod, "-c", ROLES[role], "--", "python3", "-c", CUDA_CHECK.replace("PORT", port)))
            if evidence["gpu_uuid"] != gpu["uuid"]:
                raise ValueError("Allocated engine did not execute on the one physical RTX 4090")
            result["allocated_cuda_checks"][role] = evidence
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
