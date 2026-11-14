"""Real production signer over verified local HTTPS; no inference provider calls."""
import hashlib
import json
import os
import uuid
import ssl
import socket
import sys
from urllib.parse import urlsplit
from pathlib import Path
from worker_python.internal_api import call_internal_api, uses_internal_persistence

assert uses_internal_persistence()
assert sys.version_info >= (3, 12), "Use the supported Worker Python runtime (3.12+)"
authority = ssl.PEM_cert_to_DER_cert(Path(os.environ["SSL_CERT_FILE"]).read_text())
tls_context = ssl.create_default_context()
tls_context.minimum_version = ssl.TLSVersion.TLSv1_2
assert authority in tls_context.get_ca_certs(binary_form=True), "Test CA was not loaded"
address = urlsplit(os.environ["WORKER_INTERNAL_API_ORIGIN"])
with socket.create_connection((address.hostname, address.port), timeout=5) as connection:
    with tls_context.wrap_socket(connection, server_hostname=address.hostname) as secured:
        assert secured.version() in {"TLSv1.2", "TLSv1.3"}
identity = {"jobId": "native-job", "jobType": "native_persistence_probe",
            "payloadSha256": hashlib.sha256(b"native synthetic fixture").hexdigest()}
claim = call_internal_api("claim", identity)
assert claim["status"] == "claimed"
lease = {"jobId": identity["jobId"], "leaseToken": claim["leaseToken"]}
assert call_internal_api("claim", identity) == {"status": "busy"}
assert call_internal_api("heartbeat", lease) == {"updated": True}
assert call_internal_api("claim", {**identity, "payloadSha256": "b" * 64}) == {"status": "conflict"}

secret = os.environ["WORKER_INTERNAL_API_SECRET"]
try:
    os.environ["WORKER_INTERNAL_API_SECRET"] = "incorrect-native-test-secret-0123456789"
    try:
        call_internal_api("claim", {**identity, "jobId": "unsigned-job"})
    except RuntimeError as error:
        assert str(error) == "Worker persistence API request failed"
    else:
        raise AssertionError("Invalid signature was accepted")
finally:
    os.environ["WORKER_INTERNAL_API_SECRET"] = secret

for _ in range(2):
    assert call_internal_api("processing/reserve", {"videoId": 1, "seconds": 20}) == {"allowed": True, "limitSeconds": None}
source = call_internal_api("transcription/source", {"videoId": 1})["source"]
assert "transcript" not in source
snapshot = {key: source[key] for key in ["videoId", "userId", "fileKey", "sourceRevision"]}
assert call_internal_api("transcription/begin", {**snapshot, "expectedStatus": "pending"}) == {"accepted": True}
for transcript in ["署名付き字幕 🌸", "duplicate must not overwrite"]:
    assert call_internal_api("transcription/finish", {**snapshot, "transcript": transcript, "errorCode": None}) == {"status": "indexing"}

scene_source = call_internal_api("scene-index/source", {"videoId": 1})["source"]
assert scene_source["transcript"] == "署名付き字幕 🌸"
run = {"runId": str(uuid.uuid4()), "videoId": 1, "userId": "owner",
       "sourceRevision": scene_source["sourceRevision"], "dimensions": 1536, "expectedScenes": 1}
assert call_internal_api("scene-index/start", run) == {"accepted": True}
scene = {"id": str(uuid.uuid4()), "content": "署名付き字幕 🌸", "startTime": "00:00:00,000",
         "endTime": "00:00:01,000", "embedding": [0.25] * 1536}
publication = {"runId": run["runId"], "userId": "owner"}
assert call_internal_api("scene-index/stage", {**publication, "userId": "foreign", "scenes": [scene]}) == {"accepted": False}
assert call_internal_api("scene-index/stage", {**publication, "scenes": [scene]}) == {"accepted": True}
assert call_internal_api("scene-index/publish", publication) == {"accepted": True}
assert call_internal_api("scene-index/finish", {"videoId": 1, "userId": "owner", "fileKey": "native.mp4",
       "sourceRevision": scene_source["sourceRevision"], "dimensions": 1536}) == {"status": "pending"}
assert call_internal_api("fail", {**lease, "errorCode": "WORKER_EXECUTION_FAILED"}) == {"updated": True}
retry = call_internal_api("claim", identity)
assert retry["status"] == "claimed" and retry["leaseToken"] != lease["leaseToken"]
assert call_internal_api("complete", lease) == {"updated": False}
assert call_internal_api("complete", {"jobId": identity["jobId"], "leaseToken": retry["leaseToken"]}) == {"updated": True}
print(json.dumps({"python_https_native_persistence_verified": True, "vector_delivery_pending": True,
                  "model_invoked": False, "external_queue_invoked": False}))
