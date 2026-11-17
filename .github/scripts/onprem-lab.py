"""Exercise application lifecycle in a dedicated disposable kind cluster.

Requires kind-videoq-onprem-lab and explicit kubeconfig. Backing services and AI
fixtures are test-only. No paid inference or existing site resources are used.
Caller creates and deletes the cluster. Images must already exist in Docker.
"""
import argparse
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import secrets
import re
import subprocess
import time
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
CLUSTER = "videoq-onprem-lab"
NAMESPACE = "videoq-validation"


def prepare_fixtures(data, image_tag=None):
    """Keep original immutable identities while using explicit offline aliases.

    Docker archive imports do not reliably preserve a remote multiarch index's
    name/digest in containerd. Never pretend a native manifest has that digest.
    """
    if image_tag is not None and not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", image_tag):
        raise ValueError("Expected a local Docker image tag")
    fixture, images = copy.deepcopy(data), {}
    for item in fixture["items"]:
        if item["kind"] != "Deployment": continue
        name, containers = item["metadata"]["name"], item["spec"]["template"]["spec"]["containers"]
        if name not in ("postgres", "garage", "queue") or len(containers) != 1:
            raise ValueError("Unexpected disposable backing service")
        container = containers[0]
        reference = container["image"]
        if not re.fullmatch(r"[a-z0-9./_-]+(?::[A-Za-z0-9_.-]+)?@sha256:[a-f0-9]{64}", reference):
            raise ValueError("Backing fixture images must use reviewed digests")
        alias = "videoq-lab-"+name+":"+image_tag if image_tag is not None else reference
        images[name] = {"reference":reference,"alias":alias}
        if image_tag is not None:
            container.update({"image":alias,"imagePullPolicy":"Never"})
    if set(images) != {"postgres", "garage", "queue"}:
        raise ValueError("All disposable backing services are required")
    return fixture, images


def load_native_images(images, env, output, cluster=CLUSTER):
    """Import tagged native images and verify the CRI cache before going offline.

    Containerd-backed Docker stores retain multiarch indexes even when only one
    platform's layers were pulled. Classic stores already hold native images.
    """
    def read(command, **kwargs):
        return subprocess.check_output(command,env=env,text=True,**kwargs).strip()
    info = json.loads(read(["docker","info","--format",'{{json .}}']))
    architecture = {"x86_64":"amd64","aarch64":"arm64","amd64":"amd64","arm64":"arm64"}.get(info["Architecture"])
    if info["OSType"] != "linux" or not architecture:
        raise ValueError("The lab requires native Linux amd64 or arm64 Docker images")
    platform = "linux/"+architecture
    containerd = any(k == "driver-type" and "containerd.snapshotter" in v for k,v in (info.get("DriverStatus") or []))
    if containerd:
        version = tuple(int(part) for part in read(["docker","version","--format",'{{.Server.APIVersion}}']).split('.'))
        if version < (1,48): raise ValueError("Containerd image export requires Docker API 1.48 or newer")
    imports = []
    with tempfile.TemporaryDirectory(prefix="native-images-",dir=output) as directory:
        archive = Path(directory)/"image.tar"
        for image in images:
            if not containerd and read(["docker","image","inspect",image,"--format",'{{.Os}}/{{.Architecture}}']) != platform:
                raise ValueError("The lab must import the Docker daemon's native architecture")
            command = ["docker","image","save"] + (["--platform",platform] if containerd else [])
            subprocess.run([*command,"--output",str(archive),image],env=env,check=True)
            subprocess.run(["kind","load","image-archive","--name",cluster,str(archive)],env=env,check=True)
            # ctr import can finish before CRI's asynchronous image cache sees
            # the image event. Require the alias to become usable, with a bound.
            inspect = ["docker","exec",cluster+"-control-plane","crictl","--runtime-endpoint","unix:///run/containerd/containerd.sock","inspecti",image]
            for attempt in range(30):
                try:
                    status = json.loads(read(inspect,stderr=subprocess.PIPE))["status"]
                    break
                except subprocess.CalledProcessError:
                    if attempt == 29:
                        subprocess.run(["docker","exec",cluster+"-control-plane","ctr","--namespace=k8s.io","images","list"],env=env,check=False)
                        raise
                    time.sleep(1)
            imports.append({"alias":image,"platform":platform,"criImageId":status["id"],"criCacheAttempts":attempt+1})
            archive.unlink()
    return imports


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kubeconfig", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--image-tag", default="onprem-ci")
    parser.add_argument("--chart", default="charts/videoq", help="Reviewed source chart or verified chart archive")
    parser.add_argument("--resume", action="store_true", help="Resume a failed test only in the existing disposable lab")
    parser.add_argument("--real-models", action="store_true", help="Use preloaded CPU models in the isolated acceptance cluster")
    parser.add_argument("--inference-chart", default="charts/videoq-inference")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    helm = os.environ.get("HELM_BIN", "helm")
    env = {**os.environ, "KUBECONFIG": str(args.kubeconfig.resolve())}
    if args.real_models:
        env["ONPREM_REAL_AI"] = "1"
    def run(command, data=None, binary=False):
        return subprocess.run(command, cwd=ROOT, env=env, input=data, text=not binary, check=True, stdout=subprocess.PIPE).stdout
    def k(*command, data=None, binary=False):
        return run(["kubectl", "--context", "kind-" + CLUSTER, "-n", NAMESPACE, *command], data=data, binary=binary)
    # Never select an arbitrary current context or touch the operator's config.
    context = run(["kubectl", "config", "current-context"]).strip()
    if context != "kind-" + CLUSTER:
        raise ValueError("Use the explicit disposable lab kubeconfig")
    k("get", "nodes")
    if not args.resume:
        fixture = json.loads((ROOT / ".github/onprem-lab/dependencies.json").read_text())
        fixture, _ = prepare_fixtures(fixture, args.image_tag if args.real_models else None)
        k("apply", "-f", "-", data=json.dumps(fixture))
        for name in ["postgres", "garage", "queue"]:
            k("rollout", "status", "deployment/" + name, "--timeout=300s")
    images = ["videoq-" + c + ":" + args.image_tag for c in ["api", "worker", "web"]]
    if not args.real_models:
        load_native_images(images, env, output)
    if not args.resume and not args.real_models:
        k("create", "configmap", "inference-fixture", "--from-file=inference.mjs=" + str(ROOT / ".github/onprem-lab/inference.mjs"))
        service = {"apiVersion":"v1","kind":"Service","metadata":{"name":"inference"},"spec":{"selector":{"app":"inference"},"ports":[{"port":8080}]}}
        deployment = {"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"inference"},"spec":{"replicas":1,"selector":{"matchLabels":{"app":"inference"}},"template":{"metadata":{"labels":{"app":"inference"}},"spec":{"containers":[{"name":"inference","image":images[0],"imagePullPolicy":"Never","command":["node","/fixture/inference.mjs"],"volumeMounts":[{"name":"fixture","mountPath":"/fixture"}]}],"volumes":[{"name":"fixture","configMap":{"name":"inference-fixture"}}]}}}}
        k("apply", "-f", "-", data=json.dumps({"apiVersion":"v1","kind":"List","items":[service,deployment]}))
    secret = {"DATABASE_URL":"postgresql://postgres:onprem-validation-only@postgres:5432/postgres",
              "BETTER_AUTH_SECRET":secrets.token_urlsafe(48), "USER_SECRET_ENCRYPTION_KEY":secrets.token_urlsafe(32),
              "R2_ACCESS_KEY_ID":"GK"+"0"*32, "R2_SECRET_ACCESS_KEY":"0"*64,
              "AWS_ACCESS_KEY_ID":"local-lab", "AWS_SECRET_ACCESS_KEY":"local-lab", "OPENAI_API_KEY":"local-lab"}
    def apply_secret():
        k("apply", "-f", "-", data=json.dumps({"apiVersion":"v1","kind":"Secret","metadata":{"name":"videoq-runtime"},"stringData":secret}))
    if args.resume:
        secret = {key:base64.b64decode(value).decode() for key,value in json.loads(k("get","secret","videoq-runtime","-o","json"))["data"].items()}
    else:
        apply_secret()
    values = {"fullnameOverride":"videoq", "publicUrl":"http://127.0.0.1:18787", "storage":{"endpoint":"http://127.0.0.1:19000","internalEndpoint":"http://garage:3900","bucket":"videoq-media","region":"garage"},
              "queue":{"url":"http://queue:9324/000000000000/videoq-jobs"},
              "ai":{"openaiBaseUrl":"http://inference:8080/v1","llmModel":"lab-model","whisperBackend":"local","whisperLocalUrl":"http://inference:8080/v1"},
              "config":{"videoVisualEnabled":False}}
    if args.real_models:
        values["networkPolicy"] = {"localEgressOnly":True}
        values["ai"].update({"openaiBaseUrl":"http://videoq-inference-chat:8000/v1", "llmModel":"videoq-chat",
                            "embeddingBaseUrl":"http://videoq-inference-embedding:8000/v1", "embeddingModel":"gte-qwen2-1.5b-q4km-124fbdad",
                            "separateToolSchema":True, "reasoningEffort":"none", "requestTimeoutMs":600000, "streamTimeoutMs":600000,
                            "whisperLocalUrl":"http://videoq-inference-whisper:8080/v1", "whisperChunkSeconds":30})
        resources = []
        inference_values = {"downloadModels":False, "networkPolicy":{"clientNamespace":NAMESPACE,"clientRelease":"videoq","denyEgress":True},
                            "whisper":{"image":{"repository":"videoq-whisper","tag":args.image_tag,"digest":"","pullPolicy":"Never"}},
                            "llamacpp":{"image":{"repository":"videoq-llamacpp","tag":args.image_tag,"digest":"","pullPolicy":"Never"}},
                            "whispercpp":{"images":{"amd64":{"repository":"videoq-whispercpp","tag":args.image_tag,"digest":"","pullPolicy":"Never"}}},
                            "servers":{}}
        for component in ["chat", "embedding", "whisper"]:
            name = "acceptance-models-" + component
            resources += [{"apiVersion":"v1","kind":"PersistentVolume","metadata":{"name":name},
                           "spec":{"capacity":{"storage":"10Gi"},"accessModes":["ReadOnlyMany"],"storageClassName":"",
                                   "hostPath":{"path":"/videoq-models","type":"Directory"},"persistentVolumeReclaimPolicy":"Retain"}},
                          {"apiVersion":"v1","kind":"PersistentVolumeClaim","metadata":{"name":name,"namespace":NAMESPACE},
                           "spec":{"accessModes":["ReadOnlyMany"],"storageClassName":"","volumeName":name,"resources":{"requests":{"storage":"10Gi"}}}}]
            target = inference_values["whisper"] if component == "whisper" else inference_values["servers"].setdefault(component,{})
            target["persistence"] = {"existingClaim":name}
            target["resources"] = {"requests":{"cpu":"100m","memory":"512Mi"},
                                   "limits":{"cpu":"4" if component == "chat" else "2","memory":{"chat":"8Gi","embedding":"4Gi","whisper":"2Gi"}[component]}}
        k("apply","-f","-",data=json.dumps({"apiVersion":"v1","kind":"List","items":resources}))
        inference_path = output / "inference-values.json"
        inference_path.write_text(json.dumps(inference_values))
        run([helm,"upgrade","--install","inference",args.inference_chart,"--kube-context","kind-"+CLUSTER,"--namespace",NAMESPACE,
             "-f",str(inference_path),"--wait","--timeout","15m"])
    for component in ["api", "worker", "web"]:
        values[component] = {"image":{"repository":"videoq-"+component,"tag":args.image_tag,"pullPolicy":"Never"},"resources":{"requests":{"cpu":"100m","memory":"128Mi"},"limits":{"memory":"1Gi"}}}
    values["api"].update({"databasePoolMax":2,"rateLimitPoolMax":1})
    values_path = output / "values.json"
    values_path.write_text(json.dumps(values))
    def h(*command):
        return run([helm,*command,"--kube-context","kind-"+CLUSTER,"--namespace",NAMESPACE])
    if not args.resume:
        h("install","videoq",args.chart,"-f",str(values_path),"--wait","--timeout","5m")
    if args.real_models:
        # The dedicated node firewall blocks public IPv4/IPv6 traffic. CoreDNS
        # forwarding is disabled by the caller. Check both positive/private and
        # negative/public connectivity from the actual worker Pod.
        probe = '''import json,socket,urllib.request
for host,port in [('videoq-inference-chat',8000),('videoq-inference-embedding',8000),('videoq-inference-whisper',8080)]:
 assert urllib.request.urlopen('http://'+host+':'+str(port)+'/health',timeout=10).status==200
try: socket.create_connection(('1.1.1.1',443),timeout=3)
except OSError: pass
else: raise RuntimeError('Public IP egress was allowed')
try: socket.getaddrinfo('example.com',443)
except OSError: pass
else: raise RuntimeError('Public DNS resolution was allowed')
print('Private inference reachable; public IP and DNS blocked')'''
        print(k("exec","deployment/videoq-worker","--","python","-c",probe),flush=True)
    forwards = []
    try:
        for service_name, ports in [("videoq-api","18787:8787"),("garage","19000:3900")]:
            process = subprocess.Popen(["kubectl","--context","kind-"+CLUSTER,"-n",NAMESPACE,"port-forward","service/"+service_name,ports],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            forwards.append(process)
        def ready():
            for _ in range(90):
                try:
                    with urllib.request.urlopen("http://127.0.0.1:18787/ready",timeout=2) as response:
                        if response.status==200: return
                except OSError: pass
                time.sleep(1)
            raise RuntimeError("API readiness timed out")
        ready()
        # Fixed H.264/AAC fixtures exercise browser playback without requiring
        # a video encoder in the production worker's decode/extract runtime.
        if args.real_models:
            fixture = ROOT / "apps/inference/whisper/tests/fixtures/fleurs-ja-00.mp4"
            expected = "472a0eb5062a70bb65999190bac6ff13a8e3feef171800fa670ef8142f0a3cda"
        else:
            fixture = ROOT / ".github/operations-tools/fixtures/smoke.mp4"
            expected = "d58c4123ef33a36562a4382bb2a36bff00e3151fe05593e937b39368df023671"
        video = fixture.read_bytes()
        if hashlib.sha256(video).hexdigest() != expected:
            raise ValueError("Reviewed acceptance video checksum mismatch")
        video_path = output / "video.mp4"
        video_path.write_bytes(video)
        state_path = output / "e2e-state.json"
        def e2e(mode):
            print(run(["node",".github/onprem-lab/e2e.mjs",mode,str(state_path),str(video_path)]),flush=True)
        if not args.resume:
            account = json.loads(k("exec","deployment/videoq-api","--","node","dist/provision-user.mjs","--admin","--username","onprem_lab","--email","onprem-lab@example.com"))
            state_path.write_text(json.dumps(account))
            state_path.chmod(0o600)
            e2e("register")
        e2e("upload")
        if args.real_models:
            print(run(["node",".github/onprem-lab/playback.mjs",str(state_path),str(output/"playback.json")]),flush=True)
        # Test object backup, deletion and restoration through the real S3 API.
        storage_test = '''import hashlib
from contextlib import closing
from worker_python.pipeline.storage import _s3_client,_bucket
with closing(_s3_client()) as c:
 b=_bucket(); objects=c.list_objects_v2(Bucket=b).get('Contents',[])
 assert objects
 for o in objects:
  key=o['Key']; data=c.get_object(Bucket=b,Key=key)['Body'].read(); expected=hashlib.sha256(data).hexdigest()
  c.delete_object(Bucket=b,Key=key)
  assert not c.list_objects_v2(Bucket=b,Prefix=key).get('Contents')
  c.put_object(Bucket=b,Key=key,Body=data,ContentType='video/mp4')
  assert hashlib.sha256(c.get_object(Bucket=b,Key=key)['Body'].read()).hexdigest()==expected
print('S3 object backup/delete/restore checksum passed')'''
        print(k("exec","deployment/videoq-worker","--","python","-c",storage_test),flush=True)
        for cron in ["videoq-maintenance","videoq-retention"]:
            k("patch","cronjob",cron,"--type=merge","-p",'{"spec":{"suspend":true}}')
        k("scale","deployment/videoq-api","deployment/videoq-worker","--replicas=0")
        for label in ["api", "worker"]:
            k("wait","--for=delete","pod","-l","app.kubernetes.io/component="+label,"--timeout=180s")
        backup = k("exec","deployment/postgres","--","pg_dump","-U","postgres","-Fc","postgres",binary=True)
        (output/"database.dump").write_bytes(backup)
        k("exec","deployment/postgres","--","createdb","-U","postgres","restored")
        k("exec","-i","deployment/postgres","--","pg_restore","-U","postgres","--exit-on-error","--no-owner","-d","restored",data=backup,binary=True)
        secret["DATABASE_URL"] = secret["DATABASE_URL"].removesuffix("postgres") + "restored"
        apply_secret()
        h("upgrade","videoq",args.chart,"-f",str(values_path),"--set","api.replicas=2","--wait","--timeout","5m")
        # A port-forward belongs to a Pod. Restart it after replacing all API Pods.
        forwards[0].terminate(); forwards[0].wait(timeout=10)
        forwards[0] = subprocess.Popen(["kubectl","--context","kind-"+CLUSTER,"-n",NAMESPACE,"port-forward","service/videoq-api","18787:8787"],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        ready(); e2e("restore-and-upgrade")
        h("test","videoq","--timeout","120s")
        h("rollback","videoq","1","--wait","--timeout","5m")
        forwards[0].terminate(); forwards[0].wait(timeout=10)
        forwards[0] = subprocess.Popen(["kubectl","--context","kind-"+CLUSTER,"-n",NAMESPACE,"port-forward","service/videoq-api","18787:8787"],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        ready(); e2e("rollback")
        k("create","job","lab-retention","--from=cronjob/videoq-retention")
        k("wait","--for=condition=complete","job/lab-retention","--timeout=120s")
        report = {"uploadTranscriptionIndexingAndQa":"passed", "inference":"deterministic HTTP protocol fixture; no model quality evaluation", "objectRestore":"passed; SHA256 identical", "databaseRestore":"passed; restored to a separate database and app switched", "upgrade":"passed; two API replicas and migration hook", "rollback":"passed; one API replica, restored DB and data retained", "helmTest":"passed", "retention":"passed", "images":images, "databaseBackupSha256":hashlib.sha256(backup).hexdigest()}
        if args.real_models:
            report.update({"inference":"real CPU llama.cpp chat/embeddings and whisper.cpp ASR; public Japanese FLEURS fixture",
                           "publicEgress":"blocked by dedicated node IPv4/IPv6 firewall; public DNS forwarding disabled; worker Pod probe passed",
                           "playback":json.loads((output/"playback.json").read_text()),
                           "recognitionAndAnswer":json.loads((output/"real-ai-result.json").read_text())})
        (output/("lifecycle-result.json" if args.real_models else "result.json")).write_text(json.dumps(report,indent=2)+"\n")
        print(json.dumps(report,indent=2),flush=True)
    finally:
        for process in forwards:
            process.terminate()
            process.wait(timeout=10)


if __name__ == "__main__":
    main()
