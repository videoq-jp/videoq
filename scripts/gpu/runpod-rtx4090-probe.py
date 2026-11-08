"""Preliminary 4090 VRAM/model probe inside one Runpod container, not K3s acceptance.

Use the exact runtime image declared in the exported plan. Provision first, then
run with offline model loading. Never creates cloud resources or uses site data.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import csv
import hashlib
import importlib.util
import io
import json
import math
import os
import re
from pathlib import Path
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
import wave

ROOT = Path(__file__).resolve().parents[2]
STARTUP_ORDER = ("embedding", "whisper", "chat")
PORTS = {"embedding": 8001, "whisper": 8081, "chat": 8000}
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_plan(path):
    plan = json.loads(path.read_text())
    if plan.get("schema") != 1 or plan.get("scope") != "one-container-three-process-preliminary-probe-not-k3s" or set(plan.get("roles", {})) != set(PORTS):
        raise ValueError("Expected an exported preliminary three-role plan")
    if plan.get("sourceDirty"):
        raise ValueError("Commit the reviewed probe source before exporting a hardware test plan")
    if plan["runnerSha256"] != hashlib.sha256(Path(__file__).read_bytes()).hexdigest():
        raise ValueError("Probe source differs from the reviewed plan")
    for role, config in plan["roles"].items():
        model = config["model"]
        if not re.fullmatch(r"[a-f0-9]{40}", model["revision"]) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", model["repo"]) or model.get("file") != "" or model.get("sha256") != "":
            raise ValueError("Only pinned safetensors model identities are accepted")
        if not re.fullmatch(r"ghcr\.io/videoq-jp/videoq-vllm@sha256:[a-f0-9]{64}", config["image"]):
            raise ValueError("The immutable reviewed NVIDIA runtime is required")
        if config["command"][:2] != ["vllm", "serve"] or config["command"][2] != "/models/" + config["model"]["revision"]:
            raise ValueError("Only the generated pinned vLLM model commands are accepted")
    if len({c["image"] for c in plan["roles"].values()}) != 1:
        raise ValueError("All roles must refer to the same immutable runtime")
    return plan


def ordered_roles(plan):
    return [(role, plan["roles"][role]) for role in STARTUP_ORDER]


def model_command(role, config, model_root):
    command = list(config["command"])
    command[2] = str(model_root / config["model"]["revision"])
    command[command.index("--port") + 1] = str(PORTS[role])
    command[command.index("--host") + 1] = "127.0.0.1"
    return command


def stop_processes(children):
    for child in children:
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    for child in children:
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait(timeout=10)


def health(port):
    try:
        with OPENER.open(f"http://127.0.0.1:{port}/health", timeout=2) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def wait_ready(child, port, deadline):
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError("Inference child exited before readiness; inspect the private role log")
        if health(port):
            return
        time.sleep(1)
    raise TimeoutError("Model startup exceeded the overall probe deadline")


def request(role, path, payload, content_type="application/json"):
    body = json.dumps(payload).encode() if content_type == "application/json" else payload
    req = urllib.request.Request(f"http://127.0.0.1:{PORTS[role]}{path}", data=body,
                                 headers={"Content-Type": content_type})
    with OPENER.open(req, timeout=120) as response:
        raw = response.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024:
        raise ValueError("Probe response exceeds its bounded evidence size")
    return json.loads(raw)


def wav_fixture():
    import av
    case_path = ROOT / "apps/inference/whisper/tests/fixtures/fleurs-ja-00.json"
    case = json.loads(case_path.read_text())
    clip = case_path.with_name(case["file"])
    if hashlib.sha256(clip.read_bytes()).hexdigest() != case["sha256"]:
        raise ValueError("Public FLEURS fixture checksum mismatch")
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    frames = []
    with av.open(str(clip)) as source:
        for frame in source.decode(audio=0):
            frames.extend(resampler.resample(frame))
    frames.extend(resampler.resample(None))
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
        for frame in frames:
            wav.writeframes(frame.to_ndarray().astype("<i2").tobytes())
    return output.getvalue(), case


def smoke(role, wav, case, model_alias):
    started = time.monotonic()
    if role == "embedding":
        payload = request(role, "/v1/embeddings", {"model": model_alias, "input": case["reference"], "dimensions": 1536})
        vector = payload["data"][0]["embedding"]
        if len(vector) != 1536 or not all(not isinstance(x, bool) and isinstance(x, (int, float)) and math.isfinite(x) for x in vector) or not any(vector):
            raise ValueError("Expected a real finite, nonzero 1536-dimensional embedding")
        result = {"dimensions": len(vector)}
    elif role == "chat":
        payload = request(role, "/v1/chat/completions", {"model": model_alias, "messages": [{"role": "user", "content": "日本の首都を日本語で短く答えてください。"}], "max_tokens": 64, "temperature": 0})
        answer = payload["choices"][0]["message"]["content"]
        if not isinstance(answer, str) or "東京" not in answer:
            raise ValueError("The basic Japanese chat probe did not answer Tokyo")
        result = {"text": answer}
    else:
        boundary = "videoq-probe-" + uuid.uuid4().hex
        fields = {"model": "whisper-local", "language": "ja", "response_format": "verbose_json", "timestamp_granularities[]": "segment"}
        body = b"".join((f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n').encode() for key, value in fields.items())
        body += (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="public-fleurs.wav"\r\nContent-Type: audio/wav\r\n\r\n').encode() + wav + f'\r\n--{boundary}--\r\n'.encode()
        payload = request(role, "/v1/audio/transcriptions", body, f"multipart/form-data; boundary={boundary}")
        metrics = load_module("whisper_metrics", ROOT / "apps/worker/scripts/whisper_runtime_validation.py")
        result = metrics.assess_response(payload, case)
        if result["errors"] or result["cer"] is None or result["cer"] >= .25:
            raise ValueError("Public Japanese ASR timestamp/CER probe failed: " + json.dumps(result))
    return {"elapsed_seconds": time.monotonic() - started, **result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["provision", "probe"])
    parser.add_argument("plan", type=Path)
    parser.add_argument("--model-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-seconds", type=int, default=1800)
    args = parser.parse_args()
    if not 60 <= args.max_seconds <= 3600:
        raise ValueError("The whole invocation must be bounded to 60..3600 seconds")
    plan = read_plan(args.plan)
    if args.output.exists():
        raise ValueError("Use a new evidence directory; existing data is never replaced")
    args.output.mkdir(parents=True, mode=0o700)
    deadline = time.monotonic() + args.max_seconds
    report = {"scope": plan["scope"], "source_sha": plan["sourceSha"], "declared_runtime_image": next(iter(plan["roles"].values()))["image"], "plan_sha256": hashlib.sha256(args.plan.read_bytes()).hexdigest(), "k3s_acceptance": "not established", "status": "failed"}
    children, logs, samples = [], [], []
    done = threading.Event()
    def alarm(_signal, _frame):
        raise TimeoutError("The overall bounded probe time expired")
    signal.signal(signal.SIGALRM, alarm)
    signal.alarm(args.max_seconds)
    try:
        if args.mode == "provision":
            for _role, config in ordered_roles(plan):
                env = {**os.environ, "MODEL_ROOT": str(args.model_root.resolve()), "MODEL_REPO": config["model"]["repo"], "MODEL_REVISION": config["model"]["revision"], "MODEL_FILE": "", "MODEL_SHA256": "", "HF_HUB_OFFLINE": "0"}
                subprocess.run(["python3", str(ROOT / "apps/inference/whisper/provision.py")], env=env, check=True, timeout=max(1, deadline - time.monotonic()))
            report["status"] = "provisioned-only-no-model-execution"
            return
        # A short-lived subprocess releases its CUDA context before model loading.
        device_check = """import importlib.metadata, json, sys, torch
assert importlib.metadata.version('vllm') == sys.argv[1]
assert torch.version.cuda and not torch.version.hip and torch.cuda.is_available()
assert torch.cuda.device_count() == 1
assert torch.cuda.get_device_name(0) in ('NVIDIA GeForce RTX 4090', 'NVIDIA RTX 4090')
assert torch.cuda.get_device_capability(0) == (8, 9)
a = torch.ones((32, 32), dtype=torch.float16, device='cuda')
assert bool(((a @ a) == 32).all().item())
print(json.dumps({'name': torch.cuda.get_device_name(0), 'cuda': torch.version.cuda, 'total_memory_bytes': torch.cuda.get_device_properties(0).total_memory}))
"""
        report["gpu"] = json.loads(subprocess.check_output(["python3", "-c", device_check, plan["vllmVersion"]], text=True, timeout=30))
        if report["gpu"]["total_memory_bytes"] < 23000 * 1024**2:
            raise ValueError("Expected the 24GB RTX 4090")
        def monitor():
            while not done.is_set():
                try:
                    row = subprocess.check_output(["nvidia-smi", "--query-gpu=memory.used,utilization.gpu", "--format=csv,noheader,nounits"], text=True, timeout=5)
                    rows = list(csv.reader(io.StringIO(row)))
                    if len(rows) != 1:
                        raise ValueError("Telemetry must identify exactly one allocated GPU")
                    used, utilization = rows[0]
                    used, utilization = float(used), float(utilization)
                    if not math.isfinite(used) or not math.isfinite(utilization) or used < 0 or not 0 <= utilization <= 100:
                        raise ValueError("Invalid GPU telemetry")
                    samples.append({"time": time.monotonic(), "memory_mib": used, "utilization": utilization})
                except (OSError, subprocess.SubprocessError, ValueError) as error:
                    report["telemetry_error"] = type(error).__name__
                    return
                done.wait(0.5)
        telemetry = threading.Thread(target=monitor, daemon=True); telemetry.start()
        for role, config in ordered_roles(plan):
            marker = json.loads((args.model_root / config["model"]["revision"] / ".videoq-model.json").read_text())
            if marker["identity"] != config["model"]:
                raise ValueError("Model provenance marker differs from the pinned chart")
            if health(PORTS[role]):
                raise ValueError("A probe port is already serving; refusing to reuse unrelated processes")
            log = (args.output / f"{role}.log").open("x"); logs.append(log)
            env = {**os.environ, **config["environment"], "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "VLLM_NO_USAGE_STATS": "1"}
            child = subprocess.Popen(model_command(role, config, args.model_root.resolve()), stdout=log, stderr=subprocess.STDOUT, env=env, start_new_session=True)
            children.append(child); wait_ready(child, PORTS[role], deadline)
        wav, case = wav_fixture()
        aliases = {role: config["command"][config["command"].index("--served-model-name") + 1] for role, config in plan["roles"].items()}
        report["rounds"] = []
        for _ in range(3):
            barrier = threading.Barrier(3)
            def workload(role):
                barrier.wait(timeout=10)
                return role, smoke(role, wav, case, aliases[role])
            with ThreadPoolExecutor(max_workers=3) as pool:
                report["rounds"].append(dict(pool.map(workload, PORTS)))
            if any(child.poll() is not None for child in children):
                raise RuntimeError("An inference engine exited during concurrent work")
        done.set(); telemetry.join(timeout=10)
        if telemetry.is_alive() or report.get("telemetry_error") or not samples:
            raise RuntimeError("Actual GPU memory telemetry is required")
        report["status"] = "preliminary-inference-probe-passed-not-k3s-acceptance"
    except BaseException as error:
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        signal.alarm(0); done.set(); stop_processes(children)
        for log in logs: log.close()
        report["gpu_samples"] = samples
        if samples: report["sampled_peak_memory_mib"] = max(s["memory_mib"] for s in samples)
        (args.output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"status": report["status"], "result": str(args.output / "result.json")}))


if __name__ == "__main__":
    main()
